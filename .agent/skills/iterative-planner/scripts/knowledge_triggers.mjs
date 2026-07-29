#!/usr/bin/env node
// knowledge_triggers.mjs — CLI for the Knowledge Trigger primitive (ive-ontology-memory).
//   --match --goal "<text>" [--file <path>]... [--tool-event "Write:<path>"] [--story-tag <tag>]...
//   --validate                              (validate every effective KT record's shape)
//   --capture --id <ID> --kind insight --title "..." --directive "..." [--plan-term <t>]...
//             [--file-glob <g>]... [--prompt-ref <ref>] [--proposed-from <plan/retro id>]
//   --promote <ID> --to derived|trusted [--apply-mode inject-or-block --surface gate:<name>]
//   --list-drafts                           (list un-promoted draft KTs)
//   [--config <shipped-store>] [--overlay <draft-overlay>]   (path overrides; tests never touch the shipped store)

import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import {
  loadKnowledgeTriggers, computeKnowledgeTriggerSignal, validateTrigger,
  captureTrigger, promoteTrigger, listDraftTriggers,
} from "./lib/knowledge_triggers.mjs";

function parseArgs(argv = []) {
  const args = {
    command: null, goal: "", files: [], toolEvent: "", storyTags: [], json: false,
    configPath: null, overlayPath: null,
    id: null, kind: "insight", title: "", summary: "", directive: "", promptRef: "",
    planTerms: [], fileGlobs: [], proposedFrom: null,
    to: null, applyMode: null, surface: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--match" || a === "--validate" || a === "--capture" || a === "--list-drafts") args.command = a.slice(2);
    else if (a === "--promote") { args.command = "promote"; if (argv[i + 1] && !argv[i + 1].startsWith("--")) args.id = argv[++i]; }
    else if (a === "--json") args.json = true;
    else if (a === "--goal") args.goal = argv[++i] || "";
    else if (a === "--file") args.files.push(argv[++i] || "");
    else if (a === "--tool-event") args.toolEvent = argv[++i] || "";
    else if (a === "--story-tag") args.storyTags.push(argv[++i] || "");
    else if (a === "--config") args.configPath = argv[++i] || null;
    else if (a === "--overlay") args.overlayPath = argv[++i] || null;
    else if (a === "--id") args.id = argv[++i] || null;
    else if (a === "--kind") args.kind = argv[++i] || "insight";
    else if (a === "--title") args.title = argv[++i] || "";
    else if (a === "--summary") args.summary = argv[++i] || "";
    else if (a === "--directive") args.directive = argv[++i] || "";
    else if (a === "--prompt-ref") args.promptRef = argv[++i] || "";
    else if (a === "--plan-term") args.planTerms.push(argv[++i] || "");
    else if (a === "--file-glob") args.fileGlobs.push(argv[++i] || "");
    else if (a === "--proposed-from") args.proposedFrom = argv[++i] || null;
    else if (a === "--to") args.to = argv[++i] || null;
    else if (a === "--apply-mode") args.applyMode = argv[++i] || null;
    else if (a === "--surface") args.surface = argv[++i] || null;
  }
  return args;
}

export function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const configPath = args.configPath || undefined;
  const overlayOpt = args.overlayPath ? { overlayPath: args.overlayPath } : {};

  if (args.command === "capture") {
    const candidate = {
      id: args.id,
      kind: args.kind,
      title: args.title || args.id,
      when: { plan_terms: args.planTerms, file_globs: args.fileGlobs },
      knowledge: { directive: args.directive || args.summary || args.title, prompt_ref: args.promptRef || null },
      apply: { mode: "inject", surface: "phase:explore" },
      provenance: { source: "agent", proposed_from: args.proposedFrom },
    };
    return captureTrigger(candidate, { configPath: configPath || undefined, overlayPath: args.overlayPath || undefined });
  }
  if (args.command === "promote") {
    return promoteTrigger(args.id, args.to, { overlayPath: args.overlayPath || undefined, applyMode: args.applyMode || undefined, surface: args.surface || undefined });
  }
  if (args.command === "list-drafts") {
    const drafts = listDraftTriggers({ overlayPath: args.overlayPath || undefined });
    return { ok: true, status: "PASS", count: drafts.length, drafts };
  }

  const loaded = loadKnowledgeTriggers(configPath, overlayOpt);
  if (!loaded.ok) return { ok: false, status: "FAIL", error: loaded.error };

  if (args.command === "validate") {
    const results = loaded.triggers.map((kt) => ({ id: kt?.id || "(no id)", ...validateTrigger(kt) }));
    const ok = results.every((r) => r.ok);
    return { ok, status: ok ? "PASS" : "FAIL", count: results.length, results };
  }
  // default: match
  const signal = computeKnowledgeTriggerSignal(loaded.triggers, {
    goalText: args.goal,
    files: args.files,
    toolEvent: args.toolEvent,
    storyTags: args.storyTags,
  });
  return { ok: true, status: "PASS", ...signal };
}

function printText(report) {
  if (report.drafts) {
    console.log(`Un-promoted draft Knowledge Triggers: ${report.count}`);
    for (const d of report.drafts) console.log(`  [${d.kind}] ${d.id}: ${d.title}${d.proposed_from ? ` (from ${d.proposed_from})` : ""}`);
    if (report.count > 0) console.log(`  Promote: knowledge_triggers.mjs --promote <id> --to derived`);
    return;
  }
  if (report.command === "capture" || report.written !== undefined) {
    for (const r of report.results || []) {
      console.log(`  ${r.status}: ${r.id || "(no id)"}${r.error ? " — " + (r.detail || r.error) : ""}${r.reason ? " — " + r.reason : ""}`);
    }
    console.log(`Capture: ${report.status} (${report.written || 0} draft(s) written, inert until promoted).`);
    return;
  }
  if (report.from === "draft" || report.error === "not_draft" || report.error === "not_found") {
    console.log(report.ok ? `Promoted ${report.id}: draft → ${report.to}` : `Promote FAILED: ${report.error}${report.id ? ` (${report.id})` : ""}`);
    return;
  }
  if (report.results) {
    console.log(`Knowledge Triggers validate: ${report.status} (${report.count} records)`);
    for (const r of report.results) console.log(`  ${r.ok ? "PASS" : "FAIL"}: ${r.id}${r.issues?.length ? " — " + r.issues.join("; ") : ""}`);
    return;
  }
  console.log(`Knowledge Triggers matched: ${report.count}`);
  for (const a of report.active || []) {
    console.log(`  [${a.kind}/${a.apply?.mode || "?"}] ${a.id}: ${a.title}`);
    console.log(`     matched_by: ${(a.matched_by || []).join(", ")} | surface: ${a.apply?.surface || "?"} | trust: ${a.trust_level}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = run(argv);
  if (args.json) emitJson(report);
  else printText(report);
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Validate or capture operation result enum is generated locally from operation errors.
  return report.status === "FAIL" ? 1 : 0;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}

export { parseArgs };
