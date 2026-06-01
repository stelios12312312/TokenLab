#!/usr/bin/env node

import { resolve } from "path";

import { buildOntologyFacts } from "./lib/ontology_fact_builder.mjs";
import {
  listOntologyFacts,
  runOntologyQuery,
  validateOntologyGraph,
} from "./lib/ontology_runtime.mjs";

function usage() {
  return [
    "ontology_cli.mjs",
    "",
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/ontology_cli.mjs build [--dir <repo>] [--induce] [--incremental] [--dry-run] [--json]",
    "  node .agent/skills/iterative-planner/scripts/ontology_cli.mjs query \"<prolog>\" [--dir <repo>] [--json]",
    "  node .agent/skills/iterative-planner/scripts/ontology_cli.mjs facts --entity <type> [--domain <domain>] [--dir <repo>] [--json]",
    "  node .agent/skills/iterative-planner/scripts/ontology_cli.mjs validate [--dir <repo>] [--json]",
  ].join("\n");
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    command: args.shift() || "help",
    cwd: process.cwd(),
    induce: false,
    incremental: false,
    dryRun: false,
    json: false,
    help: false,
    queryText: null,
    entity: null,
    domain: null,
    invalid: null,
  };

  while (args.length > 0) {
    const token = args.shift();
    if (!token.startsWith("-")) {
      if (options.command === "query" && options.queryText === null) {
        options.queryText = token;
        continue;
      }
      options.invalid = token;
      continue;
    }

    switch (token) {
      case "--dir":
      case "--cwd":
        options.cwd = resolve(args.shift() || process.cwd());
        break;
      case "--induce":
        options.induce = true;
        break;
      case "--incremental":
        options.incremental = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--entity":
        options.entity = args.shift() || null;
        break;
      case "--domain":
        options.domain = args.shift() || null;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        options.invalid = token;
        break;
    }
  }

  return options;
}

function humanSummary(result) {
  if (result.command === "query") return humanQuerySummary(result);
  if (result.command === "facts") return humanFactsSummary(result);
  if (result.command === "validate") return humanValidateSummary(result);

  const lines = [
    `Ontology build for ${result.cwd}`,
    `- command: build`,
    `- source: ${result.document_source}`,
    `- facts: ${result.path}`,
    `- generated_facts: ${result.wrote_generated_facts ? "wrote" : (result.changed_generated_facts ? "dry-run-change" : "up_to_date")}`,
    `- canonical_yaml: ${result.wrote_fact_documents.length > 0 ? result.wrote_fact_documents.join(", ") : "unchanged"}`,
    `- total_facts: ${result.total_fact_count}`,
    `- code: modules=${result.counts.code.modules}, files=${result.counts.code.files}`,
    `- specification: stories=${result.counts.specification.stories}, domains=${result.counts.specification.domains}, plans=${result.counts.specification.plans}`,
    `- verification: criteria=${result.counts.verification.criteria}, tests=${result.counts.verification.tests}, artifacts=${result.counts.verification.artifacts}`,
    `- process: mistakes=${result.counts.process.mistakes}, patterns=${result.counts.process.patterns}, gotchas=${result.counts.process.gotchas}, retros=${result.counts.process.retros}, adrs=${result.counts.process.adrs}, workflows=${result.counts.process.workflows}, mirror_readers=${result.counts.process.mirror_readers}, edge_cases=${result.counts.process.edge_cases}, invariants=${result.counts.process.invariants}`,
    `- proof_weights: proof_types=${result.counts.proof_weights.proof_types}, modifiers=${result.counts.proof_weights.modifiers}, risk_levels=${result.counts.proof_weights.risk_levels}, domain_defaults=${result.counts.proof_weights.domain_defaults}`,
    `- conventions: total=${result.counts.conventions.total}, active=${result.counts.conventions.active}, candidate=${result.counts.conventions.candidate}, deprecated=${result.counts.conventions.deprecated}`,
  ];

  if (result.warnings.length > 0) {
    lines.push("- warnings:");
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }

  if (result.issues.length > 0) {
    lines.push("- issues:");
    for (const issue of result.issues) lines.push(`  - ${issue}`);
  }

  return lines.join("\n");
}

function humanQuerySummary(result) {
  const lines = [
    `Ontology query for ${result.cwd}`,
    `- query: ${result.query}`,
    `- compiled_facts: ${result.compiled_facts_present ? result.compiled_path : "not written (query used canonical YAML)"}`,
    `- solutions: ${result.solution_count}`,
  ];

  if (result.solution_count > 0) {
    lines.push("- bindings:");
    for (const solution of result.solutions.slice(0, 50)) {
      const entries = Object.entries(solution);
      lines.push(entries.length > 0 ? `  - ${entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ")}` : "  - yes");
    }
    if (result.solution_count > 50) {
      lines.push(`  - ... truncated ${result.solution_count - 50} additional solution(s)`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push("- warnings:");
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }

  if (result.issues.length > 0) {
    lines.push("- issues:");
    for (const issue of result.issues) lines.push(`  - ${issue}`);
  }

  return lines.join("\n");
}

function humanFactsSummary(result) {
  const lines = [
    `Ontology facts for ${result.cwd}`,
    `- entity: ${result.entity}`,
    `- domain: ${result.domain || "all"}`,
    `- count: ${result.count}`,
    `- compiled_facts: ${result.compiled_facts_present ? result.compiled_path : "not written (facts listed from canonical YAML)"}`,
  ];

  if (result.records.length > 0) {
    lines.push("- records:");
    for (const record of result.records.slice(0, 50)) {
      lines.push(`  - ${formatFactRecord(result.entity, record)}`);
    }
    if (result.records.length > 50) {
      lines.push(`  - ... truncated ${result.records.length - 50} additional record(s)`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push("- warnings:");
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }

  if (result.issues.length > 0) {
    lines.push("- issues:");
    for (const issue of result.issues) lines.push(`  - ${issue}`);
  }

  return lines.join("\n");
}

function humanValidateSummary(result) {
  const lines = [
    `Ontology validation for ${result.cwd}`,
    `- compiled_facts: ${result.compiled_facts_present ? result.compiled_path : "not written (validation used canonical YAML)"}`,
    `- issue_count: ${result.issue_count}`,
  ];

  if (result.issue_count === 0) {
    lines.push("- status: PASS");
  } else {
    lines.push("- status: FAIL");
  }

  const categories = [
    ["schema_issues", result.schema_issues],
    ["broken_story_domains", result.broken_story_domains],
    ["dangling_plan_stories", result.dangling_plan_stories],
    ["dangling_story_criteria", result.dangling_story_criteria],
    ["missing_test_refs", result.missing_test_refs],
    ["missing_artifact_refs", result.missing_artifact_refs],
    ["dangling_test_criteria", result.dangling_test_criteria],
    ["dangling_artifact_criteria", result.dangling_artifact_criteria],
    ["dangling_test_run_tests", result.dangling_test_run_tests],
    ["dangling_retro_mistakes", result.dangling_retro_mistakes],
    ["broken_mirror_reader", result.broken_mirror_reader],
  ];

  for (const [label, values] of categories) {
    if (!Array.isArray(values) || values.length === 0) continue;
    lines.push(`- ${label}:`);
    for (const value of values) lines.push(`  - ${value}`);
  }

  if (result.warnings.length > 0) {
    lines.push("- warnings:");
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }

  return lines.join("\n");
}

function formatFactRecord(entity, record) {
  if (entity === "story") return `${record.id} — ${record.title} [${record.status}]`;
  if (entity === "workflow") return `${record.name}${record.recipe_affinity ? ` (affinity=${record.recipe_affinity})` : ""}`;
  if (entity === "mirror_reader_of" || entity === "mirror_reader") return `${record.reader} -> ${record.artifact}`;
  if (entity === "edge_case") return `${record.domain} :: ${record.label}`;
  if (entity === "module") return `${record.id}${record.path ? ` (${record.path})` : ""}`;
  if (entity === "file" || entity === "artifact" || entity === "evidence_artifact") return record.path;
  if (entity === "proof_weight" || entity === "proof_weight_type") return `${record.id} [${record.category}] base=${record.base_weight}`;
  if (entity === "proof_weight_risk_level") return `${record.risk_level} required=${record.required_weight}`;
  if (entity === "proof_weight_domain_default") return `${record.domain} -> ${record.risk_level}`;
  if (entity === "convention") return `${record.id} [${record.status}] ${record.title}`;
  if (entity === "criterion" || entity === "verification_criterion") {
    return `${record.id} (plan=${record.plan_id}${record.story_criterion_id ? `, story_criterion=${record.story_criterion_id}` : ""})`;
  }
  if (entity === "test") return `${record.name} (${record.file})`;
  if (entity === "plan") return `${record.id}${record.phase ? ` [${record.phase}]` : ""}`;
  if (entity === "domain") return `${record.name}`;
  if (entity === "coverage_report") return `${record.id} (${record.file})`;
  return JSON.stringify(record);
}

const options = parseArgs(process.argv.slice(2));
if (options.help || options.command === "help" || options.command === "--help" || options.command === "-h") {
  console.log(usage());
  process.exit(0);
}

if (options.invalid) {
  console.error(`Unknown argument: ${options.invalid}`);
  console.error(usage());
  process.exit(2);
}

let result;

if (options.command === "build") {
  result = buildOntologyFacts({
    cwd: options.cwd,
    induce: options.induce,
    incremental: options.incremental,
    dryRun: options.dryRun,
  });
  result = {
    ok: result.ok,
    command: "build",
    cwd: result.cwd,
    document_source: result.document_source,
    path: result.path,
    counts: result.counts,
    warnings: result.warnings,
    issues: result.issues,
    changed_fact_documents: result.changed_fact_documents,
    wrote_fact_documents: result.wrote_fact_documents,
    changed_generated_facts: result.changed_generated_facts,
    wrote_generated_facts: result.wrote_generated_facts,
    incremental: result.incremental,
    dryRun: result.dryRun,
    total_fact_count: result.total_fact_count,
  };
} else if (options.command === "query") {
  result = runOntologyQuery({
    cwd: options.cwd,
    queryText: options.queryText,
  });
} else if (options.command === "facts") {
  result = listOntologyFacts({
    cwd: options.cwd,
    entity: options.entity,
    domain: options.domain,
  });
} else if (options.command === "validate") {
  result = validateOntologyGraph({
    cwd: options.cwd,
  });
} else {
  console.error(`Unknown ontology command: ${options.command}`);
  console.error(usage());
  process.exit(2);
}

if (options.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(humanSummary(result));
}

process.exit(result.ok ? 0 : 1);
