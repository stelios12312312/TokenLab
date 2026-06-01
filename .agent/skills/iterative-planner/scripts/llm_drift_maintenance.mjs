#!/usr/bin/env node
// llm_drift_maintenance.mjs — Async post-task drift stewardship jobs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { dirname, join, resolve, isAbsolute } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { getPaths, resolvePlanTarget } from "./lib/plan_utils.mjs";
import {
  extractJsonObject,
  loadDriftLlmConfig,
  redactSecrets,
} from "./lib/llm_drift_client.mjs";
import { runDriftAudit } from "./llm_drift_auditor.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);

function parseArgs(argv) {
  const flags = {
    command: argv[0] || "help",
    json: argv.includes("--json"),
    help: argv.includes("--help") || argv.includes("-h"),
    plan: null,
    reason: "post_task",
    job: null,
    dir: process.cwd(),
    writeMode: null,
    mockResponse: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--plan" && argv[i + 1]) flags.plan = argv[++i];
    else if (argv[i] === "--reason" && argv[i + 1]) flags.reason = argv[++i];
    else if (argv[i] === "--job" && argv[i + 1]) flags.job = argv[++i];
    else if (argv[i] === "--dir" && argv[i + 1]) flags.dir = argv[++i];
    else if (argv[i] === "--write-mode" && argv[i + 1]) flags.writeMode = argv[++i];
    else if (argv[i] === "--mock-response" && argv[i + 1]) flags.mockResponse = argv[++i];
  }
  flags.dir = resolve(flags.dir);
  return flags;
}

function printHelp() {
  console.log(`llm_drift_maintenance.mjs — async cheap-LLM drift stewardship

Usage:
  node llm_drift_maintenance.mjs enqueue --plan <plan> --reason post_task [--json]
  node llm_drift_maintenance.mjs run --job <job> [--json] [--write-mode safe_apply|draft]

Reports:
  plans/<plan>/async/drift_maintenance_report.json
  plans/<plan>/async/drift_maintenance_report.md
`);
}

function timestampId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function safeJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function hashText(text) {
  return createHash("sha256").update(String(text || "")).digest("hex").slice(0, 16);
}

function parseJsonMaybe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    try {
      return extractJsonObject(text);
    } catch {
      return null;
    }
  }
}

function resolvePlan(cwd, planArg) {
  const { plansDir } = getPaths(cwd);
  const target = resolvePlanTarget(plansDir, { exitOnMissing: false, plan: planArg });
  if (!target.planDir) {
    throw new Error(`No plan found for ${planArg || "active pointer"}`);
  }
  return target;
}

function commandResult(cwd, scriptName, args, opts = {}) {
  const result = spawnSync(process.execPath, [join(scriptDir, scriptName), ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeoutMs || 20_000,
    env: {
      ...process.env,
      PLANNER_SKIP_SELF_HEAL: "1",
    },
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  return {
    command: `node ${scriptName} ${args.join(" ")}`,
    status: result.status,
    ok: result.status === 0 || (opts.allowExitOne && result.status === 1),
    stdout_hash: hashText(stdout),
    stderr_hash: hashText(stderr),
    stdout_excerpt: stdout.slice(0, 2500),
    stderr_excerpt: stderr.slice(0, 1200),
    parsed: opts.parseJson === false ? null : parseJsonMaybe(stdout),
  };
}

function compactCommand(result) {
  return {
    command: result.command,
    status: result.status,
    ok: result.ok,
    stdout_hash: result.stdout_hash,
    stderr_hash: result.stderr_hash,
    stdout_excerpt: result.stdout_excerpt,
    stderr_excerpt: result.stderr_excerpt,
  };
}

function summarizeAnnotations(annotationJson) {
  const files = annotationJson?.files && typeof annotationJson.files === "object"
    ? annotationJson.files
    : {};
  const annotations = Object.values(files).flat();
  const byKey = annotationJson?.summary?.by_key || {};
  const refs = {
    criteria: [],
    stories: [],
    validation_refs: [],
  };
  for (const annotation of annotations) {
    const values = Array.isArray(annotation.values) ? annotation.values : [];
    if (annotation.key === "proves") {
      refs.criteria.push(...values.map((value) => ({ value, file: annotation.file, line: annotation.line })));
    }
    if (annotation.key === "story") {
      refs.stories.push(...values.map((value) => ({ value, file: annotation.file, line: annotation.line })));
    }
    if (annotation.key === "validation_module") {
      refs.validation_refs.push({ value: annotation.file, file: annotation.file, line: annotation.line });
    }
  }
  return {
    total: annotationJson?.summary?.total_annotations || annotations.length,
    files_with_annotations: annotationJson?.summary?.files_with_annotations || Object.keys(files).length,
    by_key: byKey,
    loaded_annotations_sample: annotations.slice(0, 20).map((annotation) => ({
      file: annotation.file,
      line: annotation.line,
      key: annotation.key,
      value: annotation.value,
    })),
    affected_refs: {
      criteria: uniqueByValue(refs.criteria),
      stories: uniqueByValue(refs.stories),
      validation_refs: uniqueByValue(refs.validation_refs),
    },
  };
}

function uniqueByValue(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const key = `${entry.value}|${entry.file}|${entry.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function predicateCounts(facts) {
  const counts = {};
  for (const fact of Array.isArray(facts) ? facts : []) {
    const match = String(fact).match(/^([a-zA-Z0-9_]+)\(/);
    if (!match) continue;
    counts[match[1]] = (counts[match[1]] || 0) + 1;
  }
  return counts;
}

function diffCounts(current, previous) {
  const keys = [...new Set([...Object.keys(current || {}), ...Object.keys(previous || {})])].sort();
  return keys
    .map((key) => ({ predicate: key, before: previous?.[key] || 0, after: current?.[key] || 0 }))
    .filter((entry) => entry.before !== entry.after);
}

function summarizeTraceability(parsed) {
  return {
    summary: parsed?.summary || null,
    findings_count: Array.isArray(parsed?.findings) ? parsed.findings.length : null,
    fail: parsed?.summary?.fail ?? null,
    warn: parsed?.summary?.warn ?? null,
  };
}

function compareQuality(current, previous) {
  if (!previous) return "baseline_recorded";
  const currentFail = Number(current?.traceability?.fail ?? 0);
  const previousFail = Number(previous?.traceability?.fail ?? 0);
  const currentWarn = Number(current?.traceability?.warn ?? 0);
  const previousWarn = Number(previous?.traceability?.warn ?? 0);
  if (currentFail < previousFail || currentFail === previousFail && currentWarn < previousWarn) return "improved";
  if (currentFail > previousFail || currentFail === previousFail && currentWarn > previousWarn) return "degraded";
  return "no_effect";
}

function runOntologyUsageProof(cwd, planDirName, asyncDir, previousReport) {
  const annotationValidate = commandResult(cwd, "annotation_parser.mjs", ["--validate"], { parseJson: false, allowExitOne: true });
  const annotationJson = commandResult(cwd, "annotation_parser.mjs", ["--json"], { allowExitOne: true });
  const ontology = commandResult(cwd, "ontology_serializer.mjs", ["--json"], { allowExitOne: true });
  const invariants = commandResult(cwd, "rule_engine.mjs", ["check-invariants"], { parseJson: false, allowExitOne: true });
  const verifyStories = commandResult(cwd, "rule_engine.mjs", ["verify-stories"], { parseJson: false, allowExitOne: true });
  const storyRegistry = commandResult(cwd, "story_registry.mjs", ["check", "--json"], { allowExitOne: true });
  const traceability = commandResult(cwd, "audit_runner.mjs", ["--pack", "traceability", "--json", "--report-only", "--plan", planDirName], { allowExitOne: true });

  const facts = Array.isArray(ontology.parsed?.facts) ? ontology.parsed.facts : [];
  const currentPredicateCounts = predicateCounts(facts);
  const current = {
    ontology_fact_hash: hashText(JSON.stringify(facts)),
    ontology_predicate_counts: currentPredicateCounts,
    traceability_hash: hashText(JSON.stringify(traceability.parsed?.findings || [])),
    story_registry_hash: hashText(JSON.stringify(storyRegistry.parsed || {})),
    invariant_output_hash: invariants.stdout_hash,
    verify_stories_output_hash: verifyStories.stdout_hash,
    traceability: summarizeTraceability(traceability.parsed),
  };
  const previous = previousReport?.ontology_usage_proof?.outputs || null;
  const ontologyChanged = !!previous && previous.ontology_fact_hash !== current.ontology_fact_hash;
  const downstreamChanged = !!previous && (
    previous.traceability_hash !== current.traceability_hash ||
    previous.story_registry_hash !== current.story_registry_hash ||
    previous.invariant_output_hash !== current.invariant_output_hash ||
    previous.verify_stories_output_hash !== current.verify_stories_output_hash
  );
  const quality = compareQuality(current, previous);
  const decisionEffect = !previous
    ? "baseline_recorded"
    : ontologyChanged && !downstreamChanged
      ? "ritual_only"
      : downstreamChanged
        ? quality
        : "no_effect";
  const commands = {
    annotation_validate: compactCommand(annotationValidate),
    annotation_json: compactCommand(annotationJson),
    ontology_serializer: compactCommand(ontology),
    rule_engine_check_invariants: compactCommand(invariants),
    rule_engine_verify_stories: compactCommand(verifyStories),
    story_registry_check: compactCommand(storyRegistry),
    traceability_pack: compactCommand(traceability),
  };

  return {
    generated_at: new Date().toISOString(),
    commands,
    annotations_loaded: summarizeAnnotations(annotationJson.parsed),
    prolog_facts: {
      count: facts.length,
      hash: current.ontology_fact_hash,
      predicate_counts: currentPredicateCounts,
      changed_since_previous: ontologyChanged,
      predicate_count_deltas: diffCounts(currentPredicateCounts, previous?.ontology_predicate_counts || {}),
      changed_fact_detail: previous
        ? (ontologyChanged ? "Ontology fact hash changed; predicate deltas above show changed fact families." : "No ontology fact hash change.")
        : "No previous async maintenance report to diff against.",
    },
    audit_gate_outputs_changed: {
      downstream_changed: downstreamChanged,
      traceability_changed: !!previous && previous.traceability_hash !== current.traceability_hash,
      story_registry_changed: !!previous && previous.story_registry_hash !== current.story_registry_hash,
      invariant_output_changed: !!previous && previous.invariant_output_hash !== current.invariant_output_hash,
      verify_stories_output_changed: !!previous && previous.verify_stories_output_hash !== current.verify_stories_output_hash,
    },
    outputs: current,
    decision_effect: decisionEffect,
    classification: decisionEffect,
  };
}

function renderReportMarkdown(report) {
  const lines = [];
  lines.push("# Drift Maintenance Report");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Plan: ${report.plan}`);
  lines.push(`Status: ${report.status}`);
  lines.push(`Write mode: ${report.write_mode}`);
  lines.push("");
  lines.push("## LLM Drift Audit");
  lines.push("");
  lines.push(`Classification: ${report.llm_audit?.status || "unknown"}`);
  lines.push(`Fail-open: ${report.llm_audit?.fail_open ? "yes" : "no"}`);
  lines.push(`Summary: ${report.llm_audit?.summary || "(none)"}`);
  if (report.llm_audit?.findings?.length) {
    lines.push("");
    for (const finding of report.llm_audit.findings) {
      lines.push(`- ${finding.classification}: ${finding.surface}${finding.file ? ` (${finding.file})` : ""} - ${finding.reason || finding.claim}`);
    }
  }
  lines.push("");
  lines.push("## Ontology Usage Proof");
  lines.push("");
  lines.push(`Decision effect: ${report.ontology_usage_proof?.decision_effect || "unknown"}`);
  lines.push(`Annotations loaded: ${report.ontology_usage_proof?.annotations_loaded?.total ?? "unknown"}`);
  lines.push(`Prolog facts: ${report.ontology_usage_proof?.prolog_facts?.count ?? "unknown"} (${report.ontology_usage_proof?.prolog_facts?.hash || "no hash"})`);
  lines.push(`Downstream outputs changed: ${report.ontology_usage_proof?.audit_gate_outputs_changed?.downstream_changed ? "yes" : "no"}`);
  lines.push("");
  lines.push("## Safe Repairs");
  lines.push("");
  if (report.safe_repairs_applied.length === 0) {
    lines.push("- None.");
  } else {
    for (const repair of report.safe_repairs_applied) {
      lines.push(`- ${repair.kind}: ${repair.detail}`);
    }
  }
  if (report.review_artifacts.length > 0) {
    lines.push("");
    lines.push("## Review Artifacts");
    for (const artifact of report.review_artifacts) {
      lines.push(`- ${artifact}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function writeSemanticReview(asyncDir, edits) {
  if (!Array.isArray(edits) || edits.length === 0) return null;
  const path = join(asyncDir, "drift_semantic_review.md");
  const lines = [
    "# LLM Semantic Drift Review",
    "",
    "These are review-only suggestions. Do not apply them unless deterministic validation proves the semantic edit is unambiguous.",
    "",
  ];
  for (const edit of edits) {
    lines.push(`## ${edit.id}`);
    lines.push("");
    lines.push(`- [ ] Review ${edit.kind} in ${edit.file || "(unknown file)"}${edit.line ? `:${edit.line}` : ""}`);
    lines.push(`- Rationale: ${edit.rationale || "(none provided)"}`);
    lines.push(`- Deterministic validation: ${edit.deterministic_validation || "not_proven"}`);
    if (edit.proposed_text) {
      lines.push("");
      lines.push("```text");
      lines.push(edit.proposed_text);
      lines.push("```");
    }
    lines.push("");
  }
  writeFileSync(path, `${lines.join("\n").trimEnd()}\n`);
  return path;
}

function enqueue(flags) {
  const target = resolvePlan(flags.dir, flags.plan);
  const asyncDir = join(target.planDir, "async");
  mkdirSync(asyncDir, { recursive: true });
  const job = {
    version: 1,
    id: `drift_job_${timestampId()}`,
    status: "pending",
    reason: flags.reason || "post_task",
    plan: target.planDirName,
    plan_dir: target.planDir,
    created_at: new Date().toISOString(),
    write_mode: flags.writeMode || loadDriftLlmConfig().writeMode,
  };
  const jobPath = join(asyncDir, `${job.id}.json`);
  writeFileSync(jobPath, JSON.stringify(job, null, 2) + "\n");
  return { ok: true, job_path: jobPath, job };
}

function resolveJobPath(cwd, jobArg) {
  if (!jobArg) throw new Error("--job is required");
  const direct = isAbsolute(jobArg) ? jobArg : resolve(cwd, jobArg);
  if (existsSync(direct)) return direct;
  throw new Error(`Job not found: ${jobArg}`);
}

async function runJob(flags) {
  const jobPath = resolveJobPath(flags.dir, flags.job);
  const job = safeJson(jobPath);
  if (!job) throw new Error(`Could not parse job JSON: ${jobPath}`);
  job.status = "running";
  job.started_at = new Date().toISOString();
  writeFileSync(jobPath, JSON.stringify(job, null, 2) + "\n");

  try {
    const target = resolvePlan(flags.dir, job.plan);
    const asyncDir = join(target.planDir, "async");
    mkdirSync(asyncDir, { recursive: true });
    const reportPath = join(asyncDir, "drift_maintenance_report.json");
    const previousReport = safeJson(reportPath);
    const writeMode = flags.writeMode || job.write_mode || loadDriftLlmConfig().writeMode;

    const llmAudit = await runDriftAudit({
      dir: flags.dir,
      mode: "post_task",
      plan: target.planDirName,
      mockResponse: flags.mockResponse,
    });
    const ontologyUsageProof = runOntologyUsageProof(flags.dir, target.planDirName, asyncDir, previousReport);
    const reviewPath = writeSemanticReview(asyncDir, llmAudit.proposed_semantic_edits);
    const safeRepairsApplied = [{
      kind: "derived_report_regeneration",
      detail: "Wrote async drift maintenance JSON/Markdown reports and ontology usage proof from deterministic commands.",
      auto_applied: true,
    }];

    const report = {
      version: 1,
      generated_at: new Date().toISOString(),
      plan: target.planDirName,
      reason: job.reason || flags.reason || "post_task",
      status: llmAudit.status || "unknown",
      classification: llmAudit.status || "unknown",
      write_mode: writeMode,
      llm_audit: llmAudit,
      ontology_usage_proof: ontologyUsageProof,
      safe_repairs_applied: writeMode === "safe_apply" ? safeRepairsApplied : [],
      review_artifacts: reviewPath ? [reviewPath] : [],
      semantic_source_edits_applied: false,
    };
    writeFileSync(reportPath, redactSecrets(JSON.stringify(report, null, 2)) + "\n");
    writeFileSync(join(asyncDir, "drift_maintenance_report.md"), renderReportMarkdown(report));

    job.status = "completed";
    job.completed_at = new Date().toISOString();
    job.report_path = reportPath;
    writeFileSync(jobPath, JSON.stringify(job, null, 2) + "\n");
    return { ok: true, job_path: jobPath, report_path: reportPath, report };
  } catch (error) {
    job.status = "failed";
    job.failed_at = new Date().toISOString();
    job.error = redactSecrets(error?.message || "drift maintenance failed");
    try {
      writeFileSync(jobPath, JSON.stringify(job, null, 2) + "\n");
    } catch {
      // Preserve the original failure for the caller.
    }
    throw error;
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || flags.command === "help") {
    printHelp();
    process.exit(0);
  }
  (async () => {
    if (flags.command === "enqueue") return enqueue(flags);
    if (flags.command === "run") return runJob(flags);
    throw new Error(`Unknown command: ${flags.command}`);
  })().then((result) => {
    if (flags.json) {
      process.stdout.write(`${redactSecrets(JSON.stringify(result, null, 2))}\n`);
    } else if (flags.command === "enqueue") {
      console.log(`Enqueued drift maintenance job: ${result.job_path}`);
    } else {
      console.log(`Drift maintenance report: ${result.report_path}`);
    }
  }).catch((error) => {
    const message = redactSecrets(error?.message || "drift maintenance failed");
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    } else {
      console.error(`ERROR: ${message}`);
    }
    process.exit(1);
  });
}
