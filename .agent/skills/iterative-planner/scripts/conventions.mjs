#!/usr/bin/env node

import {
  allocateConventionIds,
  loadConventionsDocument,
  demoteConvention,
  listConventionInventory,
  loadConventionCandidateReview,
  promoteConventionCandidate,
  reviewConventionCandidate,
} from "./lib/convention_registry.mjs";
import { induceConventionCandidates } from "./convention_inducer.mjs";
import {
  buildFleetConventionScope,
  checkPlanConventions,
  evaluateActiveConventionsForFiles,
} from "./lib/convention_checks.mjs";

function readFlagValue(args, flag) {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : null;
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function positionalArgs(args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token.startsWith("-")) {
      if (index + 1 < args.length && !args[index + 1].startsWith("-")) index += 1;
      continue;
    }
    values.push(token);
  }
  return values;
}

function parseJsonFlag(args, flag) {
  const raw = readFlagValue(args, flag);
  if (raw === null) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error: `${flag} must be valid JSON: ${error.message || "invalid_json"}` };
  }
}

function usage() {
  return [
    "conventions.mjs — Convention induction, review, and lifecycle management",
    "",
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/conventions.mjs induce [--dir <repo>] [--path <subtree>] [--detector all|import_only|jsx_tree_only|class_inheritance_only] [--json] [--no-write]",
    "  node .agent/skills/iterative-planner/scripts/conventions.mjs review [--report <path>] [--json]",
    "  node .agent/skills/iterative-planner/scripts/conventions.mjs review <candidate-id> --decision <approve|reject|defer|edit> [--report <path>] [--reviewer <name>] [--notes <text>] [--set-title <text>] [--set-description <text>] [--set-domain <domain>] [--set-scope <scope>] [--set-confidence <number>] [--set-applies-to-json '<json>'] [--set-requires-json '<json>'] [--json]",
    "  node .agent/skills/iterative-planner/scripts/conventions.mjs list [--report <path>] [--source all|ontology|candidate_report] [--domain <domain>] [--status <candidate|active|deprecated>] [--confidence-below <number>] [--review-decision <pending|approve|reject|defer>] [--json]",
    "  node .agent/skills/iterative-planner/scripts/conventions.mjs check --plan <plan-id> [--json] [--no-write]",
    "  node .agent/skills/iterative-planner/scripts/conventions.mjs check --all [--json]",
    "  node .agent/skills/iterative-planner/scripts/conventions.mjs promote <candidate-id> [--report <path>] [--status <active|deprecated>] [--approved-by <name>] [--json]",
    "  node .agent/skills/iterative-planner/scripts/conventions.mjs demote <convention-id> --status <candidate|deprecated> --justification <text> [--approved-by <name>] [--json]",
    "",
    "Notes:",
    "  - review edits keep candidates pending unless you explicitly approve them",
    "  - promote requires an approved review entry from the paired .review.yaml file",
    "  - convention ids are allocated globally across ontology facts and prior candidate reports",
  ].join("\n");
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.mode === "induce") {
    console.log(`Convention induction for ${result.cwd}`);
    console.log(`- path_filter: ${result.path_filter || "repo"}`);
    console.log(`- detectors: ${result.detectors.join(", ")}`);
    console.log(`- groups_scanned: ${result.groups_scanned}`);
    console.log(`- candidate_count: ${result.candidate_count}`);
    if (result.report_path) console.log(`- report: ${result.report_path}`);
    for (const candidate of result.candidates || []) {
      console.log(`  - ${candidate.id}: ${candidate.title} [${candidate.detected_from}] confidence=${candidate.confidence}`);
    }
    return;
  }

  if (result.mode === "review") {
    console.log(`Convention review for ${result.report_path}`);
    console.log(`- review_file: ${result.review_path}`);
    if (result.entry) {
      console.log(`- updated: ${result.entry.id} decision=${result.entry.decision}`);
      console.log(`- title: ${result.candidate?.title || result.entry.title}`);
    } else {
      const reviews = result.review?.convention_candidate_review?.reviews || [];
      console.log(`- candidates: ${reviews.length}`);
      for (const entry of reviews) {
        console.log(`  - ${entry.id}: decision=${entry.decision} title=${entry.title}`);
      }
    }
    return;
  }

  if (result.mode === "list") {
    console.log("Convention inventory");
    console.log(`- total: ${result.summary.total}`);
    console.log(`- ontology: ${result.summary.ontology}`);
    console.log(`- candidate_report: ${result.summary.candidate_report}`);
    for (const record of result.records) {
      const reviewSuffix = record.review_decision ? ` review=${record.review_decision}` : "";
      console.log(`  - ${record.id}: ${record.status} ${record.domain || "repo"}/${record.scope || "scope"} source=${record.source}${reviewSuffix}`);
    }
    return;
  }

  if (result.mode === "check") {
    console.log(`Convention check (${result.scope})`);
    if (result.plan_id) console.log(`- plan: ${result.plan_id}`);
    if (result.report_path) console.log(`- report: ${result.report_path}`);
    if (Array.isArray(result.change_classes) && result.change_classes.length > 0) {
      console.log(`- change_classes: ${result.change_classes.join(", ")}`);
    }
    if (result.summary) {
      console.log(`- active_conventions: ${result.summary.active_conventions}`);
      console.log(`- applicable_results: ${result.summary.applicable_results}`);
      console.log(`- satisfied: ${result.summary.satisfied}`);
      console.log(`- violations: ${result.summary.violations}`);
      console.log(`- pending_file_creation: ${result.summary.pending_file_creation}`);
    }
    for (const entry of result.results || []) {
      console.log(`  - ${entry.convention_id} ${entry.file}: ${entry.status}`);
    }
    return;
  }

  if (result.mode === "promote") {
    console.log(`Promoted ${result.convention.id} -> ${result.convention.status}`);
    console.log(`- report: ${result.report_path}`);
    console.log(`- review: ${result.review_path}`);
    console.log(`- conventions: ${result.conventions_path}`);
    console.log(`- lifecycle: ${result.lifecycle_log_path} (${result.lifecycle_event_id})`);
    return;
  }

  if (result.mode === "demote") {
    console.log(`Demoted ${result.convention.id} -> ${result.convention.status}`);
    console.log(`- conventions: ${result.conventions_path}`);
    console.log(`- lifecycle: ${result.lifecycle_log_path} (${result.lifecycle_event_id})`);
  }
}

function printFailure(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const issue of result.issues || ["Unknown conventions error"]) {
    console.error(issue);
  }
}

function normalizeCommandArgs(args) {
  const cwd = readFlagValue(args, "--dir") || readFlagValue(args, "--cwd") || process.cwd();
  return { cwd };
}

function main(argv = process.argv) {
  const args = argv.slice(2);
  const command = args[0] || "help";
  const commandArgs = args.slice(1);
  const json = hasFlag(commandArgs, "--json");

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return 0;
  }

  if (command === "induce") {
    const { cwd } = normalizeCommandArgs(commandArgs);
    const result = induceConventionCandidates({
      cwd,
      pathFilter: readFlagValue(commandArgs, "--path"),
      detector: readFlagValue(commandArgs, "--detector") || "all",
      write: !hasFlag(commandArgs, "--no-write"),
    });
    const output = {
      mode: "induce",
      ...result,
    };
    printResult(output, json);
    return result.ok ? 0 : 1;
  }

  if (command === "review") {
    const { cwd } = normalizeCommandArgs(commandArgs);
    const positionals = positionalArgs(commandArgs);
    const conventionId = readFlagValue(commandArgs, "--id") || positionals[0] || null;
    const appliesTo = parseJsonFlag(commandArgs, "--set-applies-to-json");
    const requires = parseJsonFlag(commandArgs, "--set-requires-json");
    if (!appliesTo.ok || !requires.ok) {
      const failure = {
        ok: false,
        mode: "review",
        cwd,
        report_path: readFlagValue(commandArgs, "--report"),
        issues: [appliesTo.error || requires.error],
      };
      printFailure(failure, json);
      return 2;
    }

    const editPatch = {};
    if (readFlagValue(commandArgs, "--set-title")) editPatch.title = readFlagValue(commandArgs, "--set-title");
    if (readFlagValue(commandArgs, "--set-description")) editPatch.description = readFlagValue(commandArgs, "--set-description");
    if (readFlagValue(commandArgs, "--set-domain")) editPatch.domain = readFlagValue(commandArgs, "--set-domain");
    if (readFlagValue(commandArgs, "--set-scope")) editPatch.scope = readFlagValue(commandArgs, "--set-scope");
    const confidence = readFlagValue(commandArgs, "--set-confidence");
    if (confidence !== null) editPatch.confidence = Number(confidence);
    if (appliesTo.value !== null) editPatch.applies_to = appliesTo.value;
    if (requires.value !== null) editPatch.requires = requires.value;

    const result = reviewConventionCandidate({
      cwd,
      reportPath: readFlagValue(commandArgs, "--report"),
      conventionId,
      decision: readFlagValue(commandArgs, "--decision"),
      notes: readFlagValue(commandArgs, "--notes"),
      reviewedBy: readFlagValue(commandArgs, "--reviewer") || readFlagValue(commandArgs, "--approved-by"),
      approvedBy: readFlagValue(commandArgs, "--approved-by"),
      editPatch,
    });
    const output = {
      mode: "review",
      ...result,
    };
    if (!result.ok) {
      printFailure(output, json);
      return 1;
    }
    printResult(output, json);
    return 0;
  }

  if (command === "list") {
    const { cwd } = normalizeCommandArgs(commandArgs);
    const result = listConventionInventory({
      cwd,
      reportPath: readFlagValue(commandArgs, "--report"),
      source: readFlagValue(commandArgs, "--source") || "all",
      domain: readFlagValue(commandArgs, "--domain"),
      status: readFlagValue(commandArgs, "--status"),
      confidenceBelow: readFlagValue(commandArgs, "--confidence-below"),
      reviewDecision: readFlagValue(commandArgs, "--review-decision"),
    });
    const output = {
      mode: "list",
      ...result,
    };
    printResult(output, json);
    return 0;
  }

  if (command === "promote") {
    const { cwd } = normalizeCommandArgs(commandArgs);
    const positionals = positionalArgs(commandArgs);
    const conventionId = positionals[0] || readFlagValue(commandArgs, "--id");
    if (!conventionId) {
      const failure = {
        ok: false,
        mode: "promote",
        cwd,
        issues: ["promote requires a candidate id"],
      };
      printFailure(failure, json);
      return 2;
    }
    const result = promoteConventionCandidate({
      cwd,
      reportPath: readFlagValue(commandArgs, "--report"),
      conventionId,
      status: readFlagValue(commandArgs, "--status") || "active",
      approvedBy: readFlagValue(commandArgs, "--approved-by") || "user",
    });
    const output = {
      mode: "promote",
      ...result,
    };
    if (!result.ok) {
      printFailure(output, json);
      return 1;
    }
    printResult(output, json);
    return 0;
  }

  if (command === "check") {
    const { cwd } = normalizeCommandArgs(commandArgs);
    const write = !hasFlag(commandArgs, "--no-write");
    const all = hasFlag(commandArgs, "--all");
    if (all) {
      const loaded = loadConventionsDocument({ cwd });
      if (!loaded.ok) {
        const failure = {
          ok: false,
          mode: "check",
          scope: "fleet",
          issues: loaded.issues,
        };
        printFailure(failure, json);
        return 1;
      }

      const activeConventions = loaded.conventions.filter((entry) => entry?.status === "active");
      const files = buildFleetConventionScope({ cwd });
      const checked = evaluateActiveConventionsForFiles({ cwd, files });
      const output = {
        ok: checked.ok,
        mode: "check",
        scope: "fleet",
        plan_id: null,
        report_path: null,
        change_classes: [],
        summary: {
          active_conventions: activeConventions.length,
          applicable_results: checked.results.length,
          // proof-status-lint: exempt T-INTAKE-B07B8898 -- Convention lifecycle enum (satisfied, violated, exempted, pending_file_creation), not verification vocabulary.
          satisfied: checked.results.filter((entry) => entry.status === "satisfied").length,
          violations: checked.results.filter((entry) => entry.status === "violated").length,
          pending_file_creation: checked.results.filter((entry) => entry.status === "pending_file_creation").length,
        },
        warnings: checked.warnings || [],
        results: checked.results,
        issues: checked.issues || [],
      };
      if (!checked.ok) {
        printFailure(output, json);
        return 1;
      }
      printResult(output, json);
      return 0;
    }

    const plan = readFlagValue(commandArgs, "--plan") || positionalArgs(commandArgs)[0];
    if (!plan) {
      const failure = {
        ok: false,
        mode: "check",
        scope: "plan",
        issues: ["check requires --plan <plan-id> or --all"],
      };
      printFailure(failure, json);
      return 2;
    }

    const result = checkPlanConventions({
      cwd,
      plan,
      write,
    });
    const output = {
      scope: "plan",
      ...result,
    };
    if (!result.ok) {
      printFailure(output, json);
      return 1;
    }
    printResult(output, json);
    return 0;
  }

  if (command === "demote") {
    const { cwd } = normalizeCommandArgs(commandArgs);
    const positionals = positionalArgs(commandArgs);
    const conventionId = positionals[0] || readFlagValue(commandArgs, "--id");
    if (!conventionId) {
      const failure = {
        ok: false,
        mode: "demote",
        cwd,
        issues: ["demote requires a convention id"],
      };
      printFailure(failure, json);
      return 2;
    }
    const result = demoteConvention({
      cwd,
      conventionId,
      status: readFlagValue(commandArgs, "--status") || "candidate",
      justification: readFlagValue(commandArgs, "--justification"),
      approvedBy: readFlagValue(commandArgs, "--approved-by") || "user",
    });
    const output = {
      mode: "demote",
      ...result,
    };
    if (!result.ok) {
      printFailure(output, json);
      return 1;
    }
    printResult(output, json);
    return 0;
  }

  if (command === "next-id") {
    const { cwd } = normalizeCommandArgs(commandArgs);
    const ids = allocateConventionIds({ cwd, count: 1 });
    const output = {
      mode: "next-id",
      ok: true,
      cwd,
      next_id: ids[0] || null,
    };
    printResult(output, json);
    return 0;
  }

  console.error(`Unknown conventions subcommand: ${command}`);
  console.error(usage());
  return 2;
}

process.exitCode = main(process.argv);
