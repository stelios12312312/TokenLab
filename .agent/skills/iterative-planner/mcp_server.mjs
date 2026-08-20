#!/usr/bin/env node
// mcp_server.mjs — MCP (Model Context Protocol) server for the Iterative Planner.
//
// Exposes planner operations as phase-aware tools over stdio JSON-RPC 2.0.
// The LLM only sees tools valid for the current phase. Phase transitions
// happen when Prolog gates pass. No voluntary compliance needed.
//
// Usage (IDE config):
//   { "command": "node", "args": [".agent/skills/iterative-planner/mcp_server.mjs"] }
//
// Zero external dependencies — implements MCP stdio protocol directly.
// Delegates to existing scripts via child process for full gate enforcement.

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { execSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { createInterface } from "readline";
import {
  canonicalVerificationStatus,
  normalizeVerificationStatus,
} from "./scripts/lib/verification_status_vocabulary.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILL_PATH = __dirname;
const SCRIPTS_PATH = join(SKILL_PATH, "scripts");
const CONFIG_PATH = join(SKILL_PATH, "config");
const NODE = process.execPath;

// ---------------------------------------------------------------------------
// MCP Protocol Constants
// ---------------------------------------------------------------------------

const MCP_VERSION = "2024-11-05";
const SERVER_NAME = "iterative-planner";
const SERVER_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Tool Registry (loaded from config/mcp_tools.json)
// ---------------------------------------------------------------------------

const toolsJsonPath = join(CONFIG_PATH, "mcp_tools.json");
const TOOL_REGISTRY = JSON.parse(readFileSync(toolsJsonPath, "utf-8")).tools;

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function getCwd() {
  // MCP server runs from the project root (where .agent/ lives)
  // If PLANNER_PROJECT_ROOT is set, use that; otherwise use cwd
  return process.env.PLANNER_PROJECT_ROOT || process.cwd();
}

function getPlansDir() {
  return join(getCwd(), "plans");
}

function getActivePlanAliasMeta() {
  return {
    markdown: "plans/ACTIVE_PLAN.md",
    json: "plans/ACTIVE_PLAN.json",
    source_of_truth: "plans/.current_plan",
  };
}

function getActivePlan() {
  const plansDir = getPlansDir();
  const pointerFile = join(plansDir, ".current_plan");
  if (!existsSync(pointerFile)) return null;
  const planDirName = readFileSync(pointerFile, "utf-8").trim();
  if (!planDirName) return null;
  const planDir = join(plansDir, planDirName);
  if (!existsSync(planDir)) return null;
  return { planDirName, planDir };
}

function readStateJson(planDir) {
  const statePath = join(planDir, "state.json");
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, "utf-8"));
}

function getCurrentPhase() {
  const plan = getActivePlan();
  if (!plan) return { phase: "no_plan", plan: null, state: null };
  const state = readStateJson(plan.planDir);
  if (!state) return { phase: "no_plan", plan, state: null };
  return { phase: state.state.toLowerCase(), plan, state };
}

function readPlanFile(planDir, filename) {
  const filePath = join(planDir, filename);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf-8");
}

function appendToPlanFile(planDir, filename, content) {
  const filePath = join(planDir, filename);
  appendFileSync(filePath, content);
}

function writePlanFile(planDir, filename, content) {
  const filePath = join(planDir, filename);
  writeFileSync(filePath, content);
}

// ---------------------------------------------------------------------------
// Script execution (child process — preserves all gate enforcement)
// ---------------------------------------------------------------------------

function runScript(scriptName, args = []) {
  const scriptPath = join(SCRIPTS_PATH, scriptName);
  const result = spawnSync(NODE, [scriptPath, ...args], {
    cwd: getCwd(),
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, PATH: process.env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin" },
  });
  return {
    exitCode: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    passed: result.status === 0,
  };
}

// ---------------------------------------------------------------------------
// Prolog integration (query tool availability)
// ---------------------------------------------------------------------------

function getAvailableToolNames() {
  const { phase, plan, state } = getCurrentPhase();
  const available = [];

  for (const [toolName, toolDef] of Object.entries(TOOL_REGISTRY)) {
    const toolPhase = toolDef.phase;

    // Always-available tools
    if (toolPhase === "always") {
      available.push(toolName);
      continue;
    }

    // No-plan tools: only when no plan is active
    if (toolPhase === "no_plan") {
      if (phase === "no_plan") available.push(toolName);
      // Also show create_plan even with active plan? No — blocked by Prolog.
      // But resume_plan and list_plans are useful even with active plan.
      if (toolName === "list_plans") available.push(toolName);
      continue;
    }

    // Phase-specific tools: only in matching phase
    if (toolPhase === phase) {
      available.push(toolName);
    }
  }

  return [...new Set(available)]; // dedupe
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

const handlers = {
  // === Lifecycle tools ===

  create_plan(params) {
    const result = runScript("bootstrap.mjs", ["new", params.goal || "No goal specified"]);
    return {
      content: [{ type: "text", text: result.stdout + result.stderr }],
      ...getStatusSuffix(),
    };
  },

  resume_plan() {
    const result = runScript("bootstrap.mjs", ["resume"]);
    return {
      content: [{ type: "text", text: result.stdout + result.stderr }],
      ...getStatusSuffix(),
    };
  },

  list_plans() {
    const result = runScript("bootstrap.mjs", ["list"]);
    return {
      content: [{ type: "text", text: result.stdout + result.stderr }],
    };
  },

  // === EXPLORE tools ===

  read_kb() {
    const plansDir = getPlansDir();
    const knowledgeDir = join(plansDir, "knowledge");
    if (!existsSync(knowledgeDir)) {
      return { content: [{ type: "text", text: "No knowledge base found. This is a new project." }] };
    }

    const files = ["index.md", "mistakes.md", "patterns.md", "gotchas.md", "tech-debt.md"];
    const sections = [];
    for (const file of files) {
      const filePath = join(knowledgeDir, file);
      if (existsSync(filePath)) {
        const content = readFileSync(filePath, "utf-8");
        sections.push(`## ${file}\n\n${content}`);
      }
    }

    // Generate KB digest hash
    const digest = createHash("sha256").update(sections.join("\n")).digest("hex").slice(0, 8);

    const { plan } = getCurrentPhase();
    if (plan) {
      // Append KB_DIGEST to findings.md
      const findingsPath = join(plan.planDir, "findings.md");
      if (existsSync(findingsPath)) {
        const findings = readFileSync(findingsPath, "utf-8");
        if (!findings.includes("[KB_DIGEST:")) {
          appendToPlanFile(plan.planDir, "findings.md", `\n[KB_DIGEST:${digest}]\n`);
        }
      }
    }

    return {
      content: [{ type: "text", text: `# Knowledge Base (digest: ${digest})\n\n${sections.join("\n\n---\n\n")}` }],
      ...getStatusSuffix(),
    };
  },

  add_finding(params) {
    const { plan } = getCurrentPhase();
    if (!plan) return errorResult("No active plan");

    const { id, title, context, files } = params;
    const wordCount = (context || "").split(/\s+/).length;
    if (wordCount < 30) {
      return errorResult(`Finding context must be at least 30 words (got ${wordCount}). Add more detail.`);
    }

    // Append to findings.md Index
    const findingsContent = readPlanFile(plan.planDir, "findings.md") || "";
    const fileList = files ? `\n  Files: ${files.join(", ")}` : "";
    const entry = `\n- **${id}**: ${title}${fileList}\n`;

    if (findingsContent.includes("*To be populated during EXPLORE.*")) {
      const updated = findingsContent.replace("*To be populated during EXPLORE.*", entry);
      writePlanFile(plan.planDir, "findings.md", updated);
    } else {
      // Append after ## Index
      const indexPos = findingsContent.indexOf("## Index");
      if (indexPos >= 0) {
        const afterIndex = findingsContent.indexOf("\n", indexPos) + 1;
        const updated = findingsContent.slice(0, afterIndex) + entry + findingsContent.slice(afterIndex);
        writePlanFile(plan.planDir, "findings.md", updated);
      } else {
        appendToPlanFile(plan.planDir, "findings.md", entry);
      }
    }

    // Write detailed finding to findings/ directory
    const findingsDir = join(plan.planDir, "findings");
    mkdirSync(findingsDir, { recursive: true });
    writePlanFile(plan.planDir, `findings/${id}.md`, `# ${id}: ${title}\n\n${context}\n${fileList ? `\n## Files\n${files.join("\n")}\n` : ""}`);

    const count = countFindings(plan.planDir);
    const gateNote = count >= 3 ? "Gate requirement met (>=3 findings)." : `${3 - count} more finding(s) needed before PLAN.`;

    return {
      content: [{ type: "text", text: `Finding ${id} added. Total: ${count}. ${gateNote}` }],
      ...getStatusSuffix(),
    };
  },

  check_adjacency(params) {
    const result = runScript("blast_radius.mjs", ["--files", ...(params.files || [])]);
    if (result.exitCode !== 0 && result.exitCode !== 2) {
      const diagnostic = result.stderr.trim()
        .replace(/^ERROR:\s*/, "") ||
        "Blast radius analysis failed before producing a result.";
      return {
        ...errorResult(diagnostic),
        ...getStatusSuffix(),
      };
    }
    return {
      content: [{ type: "text", text: result.stdout || result.stderr || "Blast radius analysis complete." }],
      ...getStatusSuffix(),
    };
  },

  // === PLAN tools ===

  set_problem_statement(params) {
    const { plan } = getCurrentPhase();
    if (!plan) return errorResult("No active plan");

    const planContent = readPlanFile(plan.planDir, "plan.md") || "";
    const statement = `## Problem Statement\n\n**Expected behavior**: ${params.expected}\n\n**Current behavior**: ${params.current}\n\n**Root cause**: ${params.root_cause}\n`;

    // Replace template problem statement
    const templatePattern = /## Problem Statement\n\*[^*]+\*/;
    let updated;
    if (templatePattern.test(planContent)) {
      updated = planContent.replace(templatePattern, statement);
    } else if (planContent.includes("## Problem Statement")) {
      // Replace existing problem statement section (up to next ##)
      const start = planContent.indexOf("## Problem Statement");
      const nextSection = planContent.indexOf("\n## ", start + 1);
      updated = planContent.slice(0, start) + statement + (nextSection >= 0 ? planContent.slice(nextSection) : "");
    } else {
      updated = planContent + "\n" + statement;
    }

    writePlanFile(plan.planDir, "plan.md", updated);
    return {
      content: [{ type: "text", text: "Problem statement set. Next: list_files_to_modify" }],
      ...getStatusSuffix(),
    };
  },

  list_files_to_modify(params) {
    const { plan } = getCurrentPhase();
    if (!plan) return errorResult("No active plan");

    const planContent = readPlanFile(plan.planDir, "plan.md") || "";
    const fileList = params.files.map(f => `- ${f.action} \`${f.path}\` — ${f.reason}`).join("\n");
    const section = `## Files To Modify\n\n${fileList}\n`;

    const templatePattern = /## Files To Modify\n\*[^*]+\*/;
    let updated;
    if (templatePattern.test(planContent)) {
      updated = planContent.replace(templatePattern, section);
    } else if (planContent.includes("## Files To Modify")) {
      const start = planContent.indexOf("## Files To Modify");
      const nextSection = planContent.indexOf("\n## ", start + 1);
      updated = planContent.slice(0, start) + section + (nextSection >= 0 ? planContent.slice(nextSection) : "");
    } else {
      updated = planContent + "\n" + section;
    }

    writePlanFile(plan.planDir, "plan.md", updated);
    return {
      content: [{ type: "text", text: `${params.files.length} files registered. Next: add_step or define_verification` }],
      ...getStatusSuffix(),
    };
  },

  add_step(params) {
    const { plan } = getCurrentPhase();
    if (!plan) return errorResult("No active plan");

    const progressContent = readPlanFile(plan.planDir, "progress.md") || "# Progress\n\n## Remaining\n";
    const entry = `- [ ] Step ${params.number}: ${params.description}${params.files ? ` (${params.files.join(", ")})` : ""}\n`;

    const updated = progressContent.includes("## Remaining")
      ? progressContent.replace("## Remaining\n", `## Remaining\n${entry}`)
      : progressContent + `\n## Remaining\n${entry}`;

    writePlanFile(plan.planDir, "progress.md", updated);
    return {
      content: [{ type: "text", text: `Step ${params.number} added to progress.md.` }],
      ...getStatusSuffix(),
    };
  },

  define_verification(params) {
    const { plan } = getCurrentPhase();
    if (!plan) return errorResult("No active plan");

    const rows = params.criteria.map(c =>
      `| ${c.name} | \`${c.command}\` | ${c.pass_means} | PENDING |`
    ).join("\n");

    const content = `# Verification Strategy\n\n| Criterion | Command | Pass Means | Status |\n|-----------|---------|------------|--------|\n${rows}\n`;
    writePlanFile(plan.planDir, "verification.md", content);

    return {
      content: [{ type: "text", text: `${params.criteria.length} verification criteria defined. Next: run transition.mjs plan-to-execute` }],
      ...getStatusSuffix(),
    };
  },

  request_approval(params) {
    const { plan } = getCurrentPhase();
    if (!plan) return errorResult("No active plan");

    // Check prerequisites
    const planContent = readPlanFile(plan.planDir, "plan.md") || "";
    const checks = [];
    if (!planContent.includes("## Problem Statement") || planContent.includes("*To be defined")) {
      checks.push("BLOCKED: Problem statement not defined. Call set_problem_statement first.");
    }
    if (!planContent.includes("## Files To Modify") || planContent.includes("*To be determined")) {
      checks.push("BLOCKED: Files to modify not listed. Call list_files_to_modify first.");
    }
    const verificationContent = readPlanFile(plan.planDir, "verification.md") || "";
    if (!verificationContent || verificationContent.includes("*To be defined")) {
      checks.push("BLOCKED: Verification strategy not defined. Call define_verification first.");
    }

    if (checks.length > 0) {
      return { content: [{ type: "text", text: checks.join("\n") }] };
    }

    return {
      content: [{
        type: "text",
        text: `## Plan Ready for PLAN → EXECUTE\n\n${params.summary}\n\n` +
          `The plan has:\n` +
          `- Problem statement defined\n` +
          `- Files to modify listed\n` +
          `- Verification strategy defined\n\n` +
          `Run \`node .agent/skills/iterative-planner/scripts/transition.mjs plan-to-execute\` to execute the gate.`
      }],
      ...getStatusSuffix(),
    };
  },

  // === EXECUTE tools ===

  update_progress(params) {
    const { plan } = getCurrentPhase();
    if (!plan) return errorResult("No active plan");

    const progressContent = readPlanFile(plan.planDir, "progress.md") || "";
    const stepPattern = new RegExp(`- \\[[ x]\\] Step ${params.step}:`);
    const match = progressContent.match(stepPattern);

    if (!match) {
      return errorResult(`Step ${params.step} not found in progress.md`);
    }

    const progressLifecycle = params.status;
    const checkbox = progressLifecycle === "completed" ? "[x]" : "[ ]";
    const notes = params.notes ? ` — ${params.notes}` : "";
    const updated = progressContent.replace(
      stepPattern,
      `- ${checkbox} Step ${params.step}:${notes ? ` ${progressContent.match(new RegExp(`Step ${params.step}: ([^\n]+)`))?.[1] || ""}${notes}` : ""}`
    );

    writePlanFile(plan.planDir, "progress.md", updated);
    return {
      content: [{ type: "text", text: `Step ${params.step} marked as ${params.status}.` }],
      ...getStatusSuffix(),
    };
  },

  log_change(params) {
    const { plan } = getCurrentPhase();
    if (!plan) return errorResult("No active plan");

    const stateContent = readPlanFile(plan.planDir, "state.md") || "";
    const entry = `- ${params.action} \`${params.file}\` — ${params.description}\n`;
    const updated = stateContent.replace(
      "- (no changes yet)\n",
      entry
    ).replace(
      /## Change Manifest \(current iteration\)\n(?!- \(no changes\))/,
      (match) => match + entry
    );

    if (updated === stateContent) {
      // Append if pattern didn't match
      appendToPlanFile(plan.planDir, "state.md", entry);
    } else {
      writePlanFile(plan.planDir, "state.md", updated);
    }

    return {
      content: [{ type: "text", text: `Change logged: ${params.action} ${params.file}` }],
      ...getStatusSuffix(),
    };
  },

  create_checkpoint(params) {
    const { plan } = getCurrentPhase();
    if (!plan) return errorResult("No active plan");

    const checkpointsDir = join(plan.planDir, "checkpoints");
    mkdirSync(checkpointsDir, { recursive: true });

    const existing = existsSync(checkpointsDir) ? readFileSync(checkpointsDir).length : 0;
    const cpName = `cp-${String(existing).padStart(3, "0")}.md`;

    // Snapshot current plan state
    const snapshot = [
      `# Checkpoint: ${cpName}`,
      `Reason: ${params.reason}`,
      `Timestamp: ${new Date().toISOString()}`,
      "",
      "## State Snapshot",
      readPlanFile(plan.planDir, "state.md") || "(empty)",
      "",
      "## Progress Snapshot",
      readPlanFile(plan.planDir, "progress.md") || "(empty)",
    ].join("\n");

    writePlanFile(plan.planDir, `checkpoints/${cpName}`, snapshot);
    return {
      content: [{ type: "text", text: `Checkpoint ${cpName} created: ${params.reason}` }],
    };
  },

  add_red_team_vector(params) {
    const { plan } = getCurrentPhase();
    if (!plan) return errorResult("No active plan");

    const rtContent = readPlanFile(plan.planDir, "red_team_notes.md") || "";
    const vectorCount = (rtContent.match(/^## /gm) || []).length;
    const vectorNum = vectorCount + 1;
    const separator = rtContent
      ? (rtContent.endsWith("\n\n") ? "" : rtContent.endsWith("\n") ? "\n" : "\n\n")
      : "";

    const entry = `${separator}## Vector ${vectorNum}\nAttack: ${params.attack}\nImpact: ${params.impact}\nMitigation: ${params.mitigation}\n`;
    writePlanFile(plan.planDir, "red_team_notes.md", rtContent + entry);

    const total = vectorNum;
    const gateNote = total >= 3 ? "Gate requirement met (>=3 vectors)." : `${3 - total} more vector(s) needed before REFLECT.`;

    return {
      content: [{ type: "text", text: `Red team vector ${vectorNum} added. Total: ${total}. ${gateNote}` }],
      ...getStatusSuffix(),
    };
  },

  // === REFLECT tools ===

  add_verification_result(params) {
    const { plan } = getCurrentPhase();
    if (!plan) return errorResult("No active plan");

    const normalizedStatus = normalizeVerificationStatus(params.status, "presentation");
    if (!normalizedStatus.valid) {
      return errorResult(`Invalid verification status '${String(params.status ?? "")}'. Use a canonical presentation result.`);
    }
    const authoredStatus = canonicalVerificationStatus(params.status, "presentation");

    const verContent = readPlanFile(plan.planDir, "verification.md") || "";
    const entry = `\n## ${params.criterion}\n- **Status**: ${authoredStatus}\n- **Evidence**: ${params.evidence}\n`;
    writePlanFile(plan.planDir, "verification.md", verContent + entry);

    return {
      content: [{ type: "text", text: `Verification result recorded: ${params.criterion} = ${authoredStatus}` }],
      ...getStatusSuffix(),
    };
  },

  update_kb(params) {
    const { plan } = getCurrentPhase();
    if (!plan) return errorResult("No active plan");

    const plansDir = getPlansDir();
    const knowledgeDir = join(plansDir, "knowledge");

    if (params.type === "none") {
      // No new learnings — record the reason
      const decisionsContent = readPlanFile(plan.planDir, "decisions.md") || "";
      if (!decisionsContent.includes("[KB_UPDATED]")) {
        appendToPlanFile(plan.planDir, "decisions.md", `\n[KB_UPDATED: no new learnings — ${params.reason_if_none}]\n`);
      }
      return {
        content: [{ type: "text", text: `KB update recorded: no new learnings. Reason: ${params.reason_if_none}` }],
        ...getStatusSuffix(),
      };
    }

    const fileMap = { mistake: "mistakes.md", pattern: "patterns.md", gotcha: "gotchas.md" };
    const targetFile = fileMap[params.type];
    if (!targetFile) return errorResult(`Unknown KB type: ${params.type}`);

    const filePath = join(knowledgeDir, targetFile);
    const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : `# ${params.type}s\n`;
    const entry = `\n## ${params.id}: ${params.title} (${new Date().toISOString().split("T")[0]})\n\n${params.content}\n`;
    writeFileSync(filePath, existing + entry);

    // Mark KB as updated in decisions.md
    const decisionsContent = readPlanFile(plan.planDir, "decisions.md") || "";
    if (!decisionsContent.includes("[KB_UPDATED]")) {
      appendToPlanFile(plan.planDir, "decisions.md", `\n[KB_UPDATED: added ${params.id} to ${targetFile}]\n`);
    }

    return {
      content: [{ type: "text", text: `KB updated: ${params.id} added to ${targetFile}` }],
      ...getStatusSuffix(),
    };
  },

  // === CLOSE tools ===

  write_summary(params) {
    const { plan } = getCurrentPhase();
    if (!plan) return errorResult("No active plan");

    const changesList = params.changes.map(c => `- ${c}`).join("\n");
    const content = `# Summary\n\n${params.summary}\n\n## Changes\n\n${changesList}\n`;
    writePlanFile(plan.planDir, "summary.md", content);

    return {
      content: [{ type: "text", text: "Summary written. Plan can now be closed via CLI: node bootstrap.mjs close" }],
    };
  },

  // === Always-available tools ===

  get_state() {
    const { phase, plan, state } = getCurrentPhase();
    if (!plan) {
      return { content: [{ type: "text", text: "No active plan. Use create_plan to start one." }] };
    }

    const info = {
      phase: state.state,
      iteration: state.iteration,
      goal: state.goal,
      current_step: state.current_step,
      transitions: state.transitions.map(t => `${t.from} → ${t.to} (${t.gate_result})`),
      available_tools: getAvailableToolNames(),
    };

    return {
      content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
    };
  },

  get_gate_status() {
    const { phase, plan, state } = getCurrentPhase();
    if (!plan) {
      return { content: [{ type: "text", text: "No active plan. No gates to check." }] };
    }

    // Determine which gate is next based on current phase
    const gateMap = {
      explore: "explore-to-plan",
      plan: "plan-to-execute",
      execute: "execute-to-reflect",
      reflect: "reflect-to-validate",
      validate: "validate-to-close",
    };
    const nextGate = gateMap[phase];

    if (!nextGate) {
      return { content: [{ type: "text", text: `Phase: ${phase}. No forward gate from this phase.` }] };
    }

    // Authoritative gate preflight: the actual transition evaluator with persistence disabled.
    const result = runScript("transition.mjs", [nextGate, "--dry-run"]);

    const nextActions = getNextActions(phase, plan.planDir);

    return {
      content: [{
        type: "text",
        text: `## Gate: ${nextGate}\n\n${result.stdout}\n${result.stderr}\n\n## Next Actions\n${nextActions.map(a => `- ${a}`).join("\n")}`,
      }],
    };
  },

  get_plan_info() {
    const { plan } = getCurrentPhase();
    if (!plan) {
      return { content: [{ type: "text", text: "No active plan." }] };
    }

    const sections = [];
    for (const file of ["plan.md", "findings.md", "progress.md", "decisions.md"]) {
      const content = readPlanFile(plan.planDir, file);
      if (content) sections.push(`## ${file}\n\n${content}`);
    }

    return {
      content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
    };
  },

  request_human_help(params) {
    return {
      content: [{
        type: "text",
        text: `## Human Help Requested\n\n**Reason**: ${params.reason}\n${params.context ? `**Context**: ${params.context}\n` : ""}\n\nThe LLM agent is requesting your guidance. Please review and respond.`,
      }],
    };
  },

  diagnose_gate(params) {
    const { phase, plan, state } = getCurrentPhase();
    if (!plan) return errorResult("No active plan. Nothing to diagnose.");

    // Determine which gate to diagnose
    const gateMap = {
      explore: "explore-to-plan",
      plan: "plan-to-execute",
      execute: "execute-to-reflect",
      reflect: "reflect-to-validate",
      validate: "validate-to-close",
    };
    const gate = params.gate || gateMap[phase];
    if (!gate) {
      return errorResult(`No forward gate from phase '${phase}'. Plan may already be closed.`);
    }

    // Remedy map: Prolog guard reason → human explanation + MCP tool to call
    const remedies = {
      insufficient_findings: {
        explanation: "Fewer than 3 findings recorded. The explore phase requires at least 3 indexed findings before advancing.",
        fix: "Call `add_finding` with id, title, context (≥30 words), and optionally files. Repeat until you have 3+ findings.",
        tool: "add_finding",
      },
      kb_not_read: {
        explanation: "The knowledge base has not been read in this plan. This is required to check for prior mistakes/patterns/gotchas.",
        fix: "Call `read_kb` to read the knowledge base. This must happen before transitioning to PLAN.",
        tool: "read_kb",
      },
      findings_too_shallow: {
        explanation: "Findings exist but lack sufficient depth (context words < 30 per finding).",
        fix: "Re-add findings with richer context (≥30 words each) using `add_finding`.",
        tool: "add_finding",
      },
      no_problem_statement: {
        explanation: "The problem statement is not defined. PLAN requires: expected behavior, current behavior, and root cause.",
        fix: "Call `set_problem_statement` with expected, current, and root_cause fields.",
        tool: "set_problem_statement",
      },
      no_file_list: {
        explanation: "No files-to-modify list declared. The plan must scope which files will be touched.",
        fix: "Call `list_files_to_modify` with an array of {path, action, reason} objects.",
        tool: "list_files_to_modify",
      },
      no_verification_strategy: {
        explanation: "No verification strategy defined. Each plan needs testable success criteria.",
        fix: "Call `define_verification` with criteria [{name, command, pass_means}].",
        tool: "define_verification",
      },
      no_red_team_notes: {
        explanation: "Red-team documentation is missing. At least 3 attack vectors must be documented before reflecting.",
        fix: "Call `add_red_team_vector` with attack, impact, and mitigation. Repeat for 3+ vectors.",
        tool: "add_red_team_vector",
      },
      no_proof_of_work: {
        explanation: "No proof of work found. Verification results must include actual command output as evidence.",
        fix: "Call `add_verification_result` with real command output in the evidence field.",
        tool: "add_verification_result",
      },
      verification_not_passing: {
        explanation: "One or more verification criteria have not passed. All criteria must be PASS to close.",
        fix: "Run each verification command and record results with `add_verification_result` (status: PASS/FAIL).",
        tool: "add_verification_result",
      },
      progress_incomplete: {
        explanation: "Not all execution steps are marked completed.",
        fix: "Call `update_progress` for each remaining step with status 'completed'.",
        tool: "update_progress",
      },
      kb_not_updated: {
        explanation: "Knowledge base has not been updated with lessons learned from this plan.",
        fix: "Call `update_kb` with a mistake, pattern, or gotcha — or type 'none' with a reason.",
        tool: "update_kb",
      },
      no_transition_rule: {
        explanation: "No Prolog transition rule exists for this state pair. This transition is architecturally forbidden.",
        fix: "This is not fixable via MCP tools — the state machine does not allow this transition. Check `get_state` for valid next phases.",
        tool: "get_state",
      },
    };

    // One authoritative diagnosis surface: the complete transition evaluator,
    // with all persistence disabled.
    const result = runScript("transition.mjs", [gate, "--dry-run"]);
    const semanticResult = null;
    const gateResult = result;

    // Also run invariant check
    const invariantResult = runScript("rule_engine.mjs", ["check-invariants", "--json"]);
    let invariants = null;
    try {
      invariants = JSON.parse(invariantResult.stdout);
    } catch { /* ignore */ }

    // Build diagnosis
    const sections = [];
    sections.push(`# Gate Diagnosis: ${gate}`);
    sections.push(`**Current phase**: ${phase}`);
    sections.push(`**Gate status**: ${result.passed ? "PASS ✓" : "BLOCKED ✗"}`);

    if (semanticResult && semanticResult.blockers && semanticResult.blockers.length > 0) {
      sections.push("\n## Prolog Guard Failures\n");
      for (const blocker of semanticResult.blockers) {
        const reason = typeof blocker === "string" ? blocker : (blocker.reason || blocker.name || String(blocker));
        const remedy = remedies[reason];
        if (remedy) {
          sections.push(`### ${reason}`);
          sections.push(`- **Why**: ${remedy.explanation}`);
          sections.push(`- **Fix**: ${remedy.fix}`);
          sections.push(`- **Tool to call**: \`${remedy.tool}\``);
        } else {
          // Handle compound reasons like gate_chain_broken(X)
          const chainMatch = reason.match(/gate_chain_broken\((.+)\)/);
          if (chainMatch) {
            sections.push(`### gate_chain_broken`);
            sections.push(`- **Why**: Predecessor gate '${chainMatch[1]}' was not passed. Gates must run in order.`);
            sections.push(`- **Fix**: Complete the earlier phase first. The gate chain enforces: explore→plan→execute→reflect→validate→close.`);
            sections.push(`- **Tool to call**: \`get_state\` (check current phase and history)`);
          } else {
            sections.push(`### ${reason}`);
            sections.push(`- **Why**: Guard '${reason}' is not satisfied.`);
            sections.push(`- **Fix**: Check \`get_gate_status\` for details.`);
          }
        }
        sections.push("");
      }
    } else if (!result.passed) {
      // Fallback: parse text output for blockers
      sections.push("\n## Gate Check Output\n");
      sections.push("```");
      sections.push(result.stdout.trim());
      if (result.stderr.trim()) sections.push(result.stderr.trim());
      sections.push("```");

      // Try to extract reason names from text output and map to remedies
      const reasonMatches = result.stdout.match(/Blocked: ([^\n]+)/);
      if (reasonMatches) {
        const reasons = reasonMatches[1].split(",").map(r => r.trim());
        sections.push("\n## Remedies\n");
        for (const reason of reasons) {
          const remedy = remedies[reason];
          if (remedy) {
            sections.push(`### ${reason}`);
            sections.push(`- **Why**: ${remedy.explanation}`);
            sections.push(`- **Fix**: ${remedy.fix}`);
            sections.push(`- **Tool to call**: \`${remedy.tool}\``);
            sections.push("");
          }
        }
      }
    }

    // File-level gate checks
    if (!gateResult.passed) {
      sections.push("\n## File-Level Gate Checks\n");
      sections.push("```");
      sections.push(gateResult.stdout.trim());
      sections.push("```");
    }

    // Invariant violations
    if (invariants && invariants.violations && invariants.violations.length > 0) {
      sections.push("\n## Active Invariant Violations\n");
      for (const v of invariants.violations.slice(0, 5)) {
        sections.push(`- **${v.name || v.id}**: ${v.detail || v.description || ""}`);
      }
      if (invariants.violations.length > 5) {
        sections.push(`- ... and ${invariants.violations.length - 5} more`);
      }
    }

    if (result.passed) {
      sections.push("\n## Result\n");
      sections.push("All guards satisfied. This gate will pass when triggered.");
    }

    return {
      content: [{ type: "text", text: sections.join("\n") }],
      ...getStatusSuffix(),
    };
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countFindings(planDir) {
  const content = readPlanFile(planDir, "findings.md") || "";
  return (content.match(/- \*\*F-\d+\*\*/g) || []).length;
}

function getNextActions(phase, planDir) {
  const actions = [];
  if (phase === "explore") {
    const content = readPlanFile(planDir, "findings.md") || "";
    if (!content.includes("[KB_DIGEST:")) actions.push("read_kb — Read the knowledge base first");
    const count = countFindings(planDir);
    if (count < 3) actions.push(`add_finding — Need ${3 - count} more finding(s)`);
    if (count >= 3 && content.includes("[KB_DIGEST:")) actions.push("Ready for PLAN phase — gate should pass");
  } else if (phase === "plan") {
    const planContent = readPlanFile(planDir, "plan.md") || "";
    if (planContent.includes("*To be defined") || !planContent.includes("**Expected behavior**")) {
      actions.push("set_problem_statement — Define the problem first");
    }
    if (planContent.includes("*To be determined") || !planContent.includes("## Files To Modify\n\n-")) {
      actions.push("list_files_to_modify — Declare files to touch");
    }
    const verContent = readPlanFile(planDir, "verification.md") || "";
    if (verContent.includes("*To be defined") || !verContent.includes("| Criterion")) {
      actions.push("define_verification — Set success criteria");
    }
    actions.push("transition.mjs plan-to-execute — When all above are done");
  } else if (phase === "execute") {
    actions.push("update_progress — Mark steps as you complete them");
    const rtContent = readPlanFile(planDir, "red_team_notes.md") || "";
    const vectorCount = (rtContent.match(/^## /gm) || []).length;
    if (vectorCount < 3) actions.push(`add_red_team_vector — Need ${3 - vectorCount} more vector(s)`);
  } else if (phase === "reflect") {
    actions.push("add_verification_result — Record test results with evidence");
    actions.push("update_kb — Add lessons learned");
  }
  return actions.length > 0 ? actions : ["No specific actions — check gate status"];
}

function getStatusSuffix() {
  const { phase, plan } = getCurrentPhase();
  const nextActions = plan ? getNextActions(phase, plan.planDir) : [];
  return {
    _meta: {
      phase,
      next_actions: nextActions,
      active_plan_alias: getActivePlanAliasMeta(),
      active_plan_dir: plan ? `plans/${plan.planDirName}` : null,
    },
  };
}

function errorResult(message) {
  return {
    content: [{ type: "text", text: `ERROR: ${message}` }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// MCP stdio protocol (JSON-RPC 2.0 over stdin/stdout)
// ---------------------------------------------------------------------------

function sendResponse(id, result) {
  const response = { jsonrpc: "2.0", id, result };
  const json = JSON.stringify(response);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function sendError(id, code, message) {
  const response = { jsonrpc: "2.0", id, error: { code, message } };
  const json = JSON.stringify(response);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function sendNotification(method, params) {
  const notification = { jsonrpc: "2.0", method, params };
  const json = JSON.stringify(notification);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function handleRequest(msg) {
  const { method, id, params } = msg;

  switch (method) {
    case "initialize":
      return sendResponse(id, {
        protocolVersion: MCP_VERSION,
        capabilities: {
          tools: { listChanged: true },
        },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case "initialized":
      // Client acknowledgment — no response needed
      return;

    case "tools/list": {
      const availableNames = getAvailableToolNames();
      const tools = availableNames
        .filter(name => TOOL_REGISTRY[name])
        .map(name => ({
          name,
          description: TOOL_REGISTRY[name].description,
          inputSchema: TOOL_REGISTRY[name].inputSchema,
        }));
      return sendResponse(id, { tools });
    }

    case "tools/call": {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};

      // Phase enforcement: check if tool is available
      const available = getAvailableToolNames();
      if (!available.includes(toolName)) {
        const { phase } = getCurrentPhase();
        const toolDef = TOOL_REGISTRY[toolName];
        const requiredPhase = toolDef?.phase || "unknown";
        return sendResponse(id, {
          content: [{
            type: "text",
            text: `BLOCKED: Tool '${toolName}' is not available in the current phase (${phase}). ` +
              `This tool requires phase: ${requiredPhase}. ` +
              `Complete the current phase's requirements first. Use get_gate_status to see what's needed.`,
          }],
          isError: true,
        });
      }

      // Execute handler
      const handler = handlers[toolName];
      if (!handler) {
        return sendResponse(id, errorResult(`No handler for tool: ${toolName}`));
      }

      try {
        const result = handler(toolArgs);
        // Handle async handlers
        if (result && typeof result.then === "function") {
          result.then(r => sendResponse(id, r)).catch(e => sendResponse(id, errorResult(e.message)));
        } else {
          return sendResponse(id, result);
        }
      } catch (e) {
        return sendResponse(id, errorResult(e.message));
      }
      return;
    }

    case "ping":
      return sendResponse(id, {});

    default:
      if (id !== undefined) {
        return sendError(id, -32601, `Method not found: ${method}`);
      }
  }
}

// ---------------------------------------------------------------------------
// stdin message parser (Content-Length framing)
// ---------------------------------------------------------------------------

let buffer = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;

  while (true) {
    // Look for Content-Length header
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;

    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      // No Content-Length — try parsing as raw JSON (some clients don't send headers)
      const nlPos = buffer.indexOf("\n");
      if (nlPos < 0) break;
      const line = buffer.slice(0, nlPos).trim();
      buffer = buffer.slice(nlPos + 1);
      if (line) {
        try {
          handleRequest(JSON.parse(line));
        } catch { /* skip malformed */ }
      }
      continue;
    }

    const contentLength = parseInt(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) break;

    const body = buffer.slice(bodyStart, bodyStart + contentLength);
    buffer = buffer.slice(bodyStart + contentLength);

    try {
      handleRequest(JSON.parse(body));
    } catch (e) {
      sendError(null, -32700, `Parse error: ${e.message}`);
    }
  }
});

process.stdin.on("end", () => {
  // Let the event loop drain stdout/stderr instead of forcing exit, which can
  // truncate buffered MCP responses in fast test/stdio scenarios.
  process.exitCode = 0;
});

// Prevent unhandled rejection crashes
process.on("unhandledRejection", (e) => {
  process.stderr.write(`MCP server error: ${e.message}\n`);
});

// Log startup to stderr (stdout is reserved for MCP protocol)
process.stderr.write(`Iterative Planner MCP server v${SERVER_VERSION} started (protocol ${MCP_VERSION})\n`);
