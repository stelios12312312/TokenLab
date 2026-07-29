#!/usr/bin/env node
// insight_induction.mjs - Generate semantic gaps and improvement opportunities
// from the active ontology graph.

import { execFileSync } from "child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, extname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const repoRoot = resolve(scriptDir, "..", "..", "..", "..");
const serializerPath = join(scriptDir, "ontology_serializer.mjs");

function parseArgs(argv) {
  const args = {
    focus: "repo",
    output: join(repoRoot, "reports", "sme_improvement"),
    agent: "offline",
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--focus") {
      args.focus = argv[++i] || args.focus;
    } else if (arg === "--output") {
      args.output = argv[++i] || args.output;
    } else if (arg === "--agent") {
      args.agent = argv[++i] || args.agent;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }

  return args;
}

function usage() {
  return [
    "Usage: node .agent/skills/iterative-planner/scripts/insight_induction.mjs [options]",
    "",
    "Options:",
    "  --focus <id-or-term>   Story, file, ticket, or semantic focus (default: repo)",
    "  --output <path>        Output directory or .json path (default: reports/sme_improvement)",
    "  --agent <name-or-md>   offline, research, custom label, or markdown response file",
    "  --json                 Print JSON report to stdout",
  ].join("\n");
}

function safeFocus(value) {
  return String(value || "repo")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "repo";
}

function invokeOntologySerializer() {
  const outputDir = mkdtempSync(join(tmpdir(), "planner-ontology-serializer-"));
  const outputPath = join(outputDir, "ontology.json");
  const outputFd = openSync(outputPath, "w");
  try {
    execFileSync(process.execPath, [serializerPath, "--json"], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 30 * 1024 * 1024,
      stdio: ["ignore", outputFd, "pipe"],
    });
    closeSync(outputFd);
    return JSON.parse(readFileSync(outputPath, "utf-8"));
  } finally {
    try {
      closeSync(outputFd);
    } catch {
      // The descriptor was already closed after a successful probe.
    }
    rmSync(outputDir, { recursive: true, force: true });
  }
}

function atomTokens(text) {
  const tokens = new Set();
  const source = String(text || "");
  const quoted = source.matchAll(/'([^']+)'/g);
  for (const match of quoted) {
    if (match[1] && match[1].length <= 200) tokens.add(match[1]);
  }
  const ids = source.match(/\b(?:US|T|PGM|EP|AC|VM|M|R)-[A-Z0-9_.-]+\b/g) || [];
  for (const id of ids) tokens.add(id);
  return [...tokens];
}

function includesToken(text, token) {
  return String(text || "").toLowerCase().includes(String(token || "").toLowerCase());
}

function extractFocusedSubgraph(graph, focus) {
  const facts = Array.isArray(graph?.facts) ? graph.facts.map(String) : [];
  const related = new Set([focus]);
  const direct = facts.filter((fact) => includesToken(fact, focus));
  for (const fact of direct) {
    for (const token of atomTokens(fact)) related.add(token);
  }

  const relatedTerms = [...related].filter(Boolean);
  const localized = facts.filter((fact) => relatedTerms.some((term) => includesToken(fact, term)));
  const selected = (localized.length > 0 ? localized : facts.slice(0, 80)).slice(0, 240);

  return {
    focus,
    fact_count: selected.length,
    total_fact_count: facts.length,
    related_terms: relatedTerms.slice(0, 80),
    facts: selected,
    direct_match_count: direct.length,
    degraded: direct.length === 0,
  };
}

function formatPrompt({ focus, subgraph }) {
  const facts = subgraph.facts.slice(0, 120).join("\n");
  return [
    "# Semantic Insight Induction",
    "",
    `Focus: ${focus}`,
    "",
    "Task: inspect this localized ontology subgraph and identify semantic/traceability gaps plus ranked opportunities.",
    "",
    "Rules of interest:",
    "- Prefer concrete story/file/config/evidence links over generic advice.",
    "- Distinguish deterministic gaps from advisory opportunities.",
    "- Flag false-green risks where an artifact can exist without answering the operator's actual question.",
    "- Keep recommendations locally verifiable.",
    "",
    "## Subgraph Facts",
    "```prolog",
    facts || "% no localized facts matched the focus",
    "```",
    "",
    "Respond with:",
    "## Semantic Gaps",
    "- [severity] gap text",
    "",
    "## Opportunities",
    "1. [priority] opportunity text",
  ].join("\n");
}

function factPredicate(fact) {
  const match = String(fact || "").match(/^([a-z_][a-z0-9_]*)\s*\(/);
  return match ? match[1] : null;
}

function deterministicMarkdownResponse({ focus, subgraph, graph }) {
  const predicates = new Set(subgraph.facts.map(factPredicate).filter(Boolean));
  const hasStory = subgraph.facts.some((fact) => fact.startsWith("story("));
  const hasCode = subgraph.facts.some((fact) => fact.startsWith("code_ref("));
  const hasValidation = subgraph.facts.some((fact) => fact.startsWith("validation_ref("));
  const hasMistake = subgraph.facts.some((fact) => fact.includes("active_mistake") || fact.includes("mistake_"));
  const hasCriterion = subgraph.facts.some((fact) => fact.includes("success_criterion") || fact.includes("criterion_story"));

  const gaps = [];
  if (subgraph.degraded) {
    gaps.push(`[high] Focus ${focus} did not directly match ontology facts; traceability may be missing or named differently.`);
  }
  if (!hasStory) {
    gaps.push(`[high] Focus ${focus} has no localized story fact in the serialized graph.`);
  }
  if (!hasCode) {
    gaps.push(`[medium] Focus ${focus} has no localized code_ref facts, so implementation ownership may be weak.`);
  }
  if (!hasValidation) {
    gaps.push(`[medium] Focus ${focus} has no localized validation_ref facts, so proof may rely on indirect plan evidence.`);
  }
  if (!hasCriterion) {
    gaps.push(`[medium] Focus ${focus} is not tied to localized success criteria in the selected subgraph.`);
  }
  if (gaps.length === 0) {
    gaps.push(`[low] Focus ${focus} has story, code, criteria, and validation links; remaining risk is whether the linked commands exercise the real behavior.`);
  }

  const opportunities = [
    `[high] Add or verify criterion-level evidence for ${focus} so generated reports cannot pass by freshness alone.`,
    `[medium] Review adjacent predicates (${[...predicates].slice(0, 8).join(", ") || "none"}) for the same traceability pattern.`,
    `[medium] Compare story tags, code refs, and validation refs after implementation to catch false-green mapping.`,
  ];
  if (hasMistake) {
    opportunities.push("[medium] Carry active mistake guards into verification.md with explicit hook evidence before reflect.");
  }
  if (graph?.meta?.active_mistakes > 0) {
    opportunities.push(`[low] Use the ${graph.meta.active_mistakes} active mistake signal(s) as adversarial prompts for closeout review.`);
  }

  return [
    "## Semantic Gaps",
    ...gaps.map((gap) => `- ${gap}`),
    "",
    "## Opportunities",
    ...opportunities.map((opportunity, index) => `${index + 1}. ${opportunity}`),
  ].join("\n");
}

function sectionBody(markdown, headingNames) {
  const names = Array.isArray(headingNames) ? headingNames : [headingNames];
  const wanted = new Set(names.map((name) => String(name || "").trim().toLowerCase()));
  const lines = String(markdown || "").split(/\r?\n/);
  let collecting = false;
  const body = [];
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      const title = heading[1].trim().toLowerCase();
      if (collecting) break;
      collecting = wanted.has(title);
      continue;
    }
    if (collecting) body.push(line);
  }
  return body.join("\n").trim();
}

function parseRankedLine(line, fallbackSeverity = "medium") {
  const cleaned = String(line || "")
    .replace(/^\s*(?:[-*]|\d+[.)])\s*/, "")
    .trim();
  if (!cleaned) return null;
  const severityMatch = cleaned.match(/^\[([^\]]+)\]\s*(.*)$/);
  return {
    severity: severityMatch ? severityMatch[1].trim().toLowerCase() : fallbackSeverity,
    text: severityMatch ? severityMatch[2].trim() : cleaned,
  };
}

export function parseAgentMarkdown(markdown) {
  const gapBody = sectionBody(markdown, ["Semantic Gaps", "Identified Semantic/Traceability Gaps", "Gaps"]);
  const opportunityBody = sectionBody(markdown, ["Opportunities", "Ranked Improvements", "Improvements"]);

  const gaps = gapBody
    .split(/\r?\n/)
    .map((line) => parseRankedLine(line, "medium"))
    .filter(Boolean);
  const opportunities = opportunityBody
    .split(/\r?\n/)
    .map((line) => parseRankedLine(line, "medium"))
    .filter(Boolean)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));

  return { gaps, opportunities };
}

function resolveAgentResponse({ agent, focus, subgraph, graph }) {
  if (agent && existsSync(resolve(repoRoot, agent))) {
    return {
      mode: "markdown_file",
      markdown: readFileSync(resolve(repoRoot, agent), "utf-8"),
    };
  }
  if (agent && existsSync(agent)) {
    return {
      mode: "markdown_file",
      markdown: readFileSync(agent, "utf-8"),
    };
  }
  return {
    mode: agent === "offline" ? "offline" : "offline_fallback",
    markdown: deterministicMarkdownResponse({ focus, subgraph, graph }),
  };
}

function outputPaths(output, focus) {
  const safe = safeFocus(focus);
  const resolved = resolve(repoRoot, output || join("reports", "sme_improvement"));
  if (extname(resolved).toLowerCase() === ".json") {
    return {
      jsonPath: resolved,
      mdPath: resolved.replace(/\.json$/i, ".md"),
    };
  }
  return {
    jsonPath: join(resolved, `${safe}_insight_induction.json`),
    mdPath: join(resolved, `${safe}_insight_induction.md`),
  };
}

function renderMarkdownReport(report) {
  const gapLines = report.gaps.length > 0
    ? report.gaps.map((gap) => `- [${gap.severity}] ${gap.text}`)
    : ["- [low] No gaps parsed from agent response."];
  const opportunityLines = report.opportunities.length > 0
    ? report.opportunities.map((item) => `${item.rank}. [${item.severity}] ${item.text}`)
    : ["1. [low] No opportunities parsed from agent response."];
  const factLines = report.subgraph.facts.slice(0, 80).map((fact) => `- \`${fact.replace(/`/g, "'")}\``);

  return [
    `# Insight Induction: ${report.focus}`,
    "",
    `Generated: ${report.generated_at}`,
    `Agent mode: ${report.agent_mode}`,
    `Subgraph facts: ${report.subgraph.fact_count}/${report.subgraph.total_fact_count}`,
    "",
    "## Semantic Gaps",
    ...gapLines,
    "",
    "## Opportunities",
    ...opportunityLines,
    "",
    "## Related Terms",
    report.subgraph.related_terms.length > 0 ? report.subgraph.related_terms.map((term) => `- ${term}`).join("\n") : "- none",
    "",
    "## Subgraph Facts",
    ...factLines,
  ].join("\n") + "\n";
}

export function runInsightInduction(options = {}) {
  const focus = options.focus || "repo";
  const graph = invokeOntologySerializer();
  const subgraph = extractFocusedSubgraph(graph, focus);
  const prompt = formatPrompt({ focus, subgraph });
  const agentResponse = resolveAgentResponse({ agent: options.agent || "offline", focus, subgraph, graph });
  const parsed = parseAgentMarkdown(agentResponse.markdown);

  const report = {
    version: 1,
    generated_at: new Date().toISOString(),
    focus,
    agent: options.agent || "offline",
    agent_mode: agentResponse.mode,
    serializer_meta: graph.meta || {},
    subgraph,
    prompt,
    response_markdown: agentResponse.markdown,
    gaps: parsed.gaps,
    opportunities: parsed.opportunities,
  };

  const paths = outputPaths(options.output || join("reports", "sme_improvement"), focus);
  mkdirSync(dirname(paths.jsonPath), { recursive: true });
  mkdirSync(dirname(paths.mdPath), { recursive: true });
  writeFileSync(paths.jsonPath, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(paths.mdPath, renderMarkdownReport(report));
  return { report, paths };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const { report, paths } = runInsightInduction(args);
  if (args.json) {
    emitJson({ ...report, output: paths });
  } else {
    console.log(`Insight induction complete for ${report.focus}`);
    console.log(`JSON: ${paths.jsonPath}`);
    console.log(`Markdown: ${paths.mdPath}`);
    console.log(`Gaps: ${report.gaps.length}; opportunities: ${report.opportunities.length}`);
  }
}

if (isDirectInvocation(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`insight_induction failed: ${error.message}`);
    process.exitCode = 1;
  }
}
