#!/usr/bin/env node
// trace_auditor.mjs — Verify tool trace coverage against per-phase rules.
//
// Reads {plan-dir}/artifacts/tool_trace.jsonl and checks whether the agent
// actually read the required files during each phase. Produces PASS/WARN/FAIL
// results with stable failure codes (GATE-TRC-*).
//
// CLI:
//   node trace_auditor.mjs                          # Auto-detect phase from state.json
//   node trace_auditor.mjs --phase EXPLORE          # Override phase
//   node trace_auditor.mjs --plan-dir <dir>         # Override plan directory
//   node trace_auditor.mjs --import-antigravity <f> # Import Antigravity trace
//
// Programmatic:
//   import { auditTrace } from "./trace_auditor.mjs";
//   const { results, coverage } = auditTrace(planDir, "EXPLORE");
//
// Zero dependencies — Node.js 18+.

import { readFileSync, existsSync, readdirSync } from "fs";
import { join, dirname, resolve, basename } from "path";
import { fileURLToPath } from "url";
import {
  getPaths, readPointer, readFile, resolvePlanTarget,
  check, PASS, WARN, FAIL,
  printHeader, printSection, printResultsWithCodes, printSummaryWithCodes,
  matchGlob, debugLog,
} from "./lib/plan_utils.mjs";
import { isFeatureEnabled, withFailureCode, readStateJson, nowISO } from "./lib/determinism.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { verificationStatusIsPass } from "./lib/verification_status_vocabulary.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configDir = resolve(__dirname, "..", "config");

// ---------------------------------------------------------------------------
// Load trace rules
// ---------------------------------------------------------------------------

let _rulesCache = null;

function loadTraceRules() {
  if (_rulesCache) return _rulesCache;
  const rulesPath = join(configDir, "trace_rules.json");
  try {
    _rulesCache = JSON.parse(readFileSync(rulesPath, "utf-8"));
  } catch (e) {
    debugLog("trace_auditor", `Failed to load trace_rules.json: ${e.message}`);
    _rulesCache = { rules: {}, coverage_threshold: { minimum_pct: 60 } };
  }
  return _rulesCache;
}

// ---------------------------------------------------------------------------
// Load and filter trace entries
// ---------------------------------------------------------------------------

/**
 * Load tool_trace.jsonl entries for a given plan directory.
 * @param {string} planDir - Absolute path to plan directory
 * @returns {Array<object>} Parsed JSONL entries
 */
function loadTraceEntries(planDir) {
  const tracePath = join(planDir, "artifacts", "tool_trace.jsonl");
  if (!existsSync(tracePath)) return [];
  try {
    const content = readFileSync(tracePath, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Filter trace entries to a specific phase.
 * Uses the phase field written by the hook, plus timestamp boundaries from state.json.
 * @param {Array} entries - All trace entries
 * @param {string} phase - Target phase (EXPLORE, PLAN, EXECUTE, REFLECT, VALIDATE)
 * @param {object} stateJson - Current state.json for timestamp boundaries
 * @returns {Array} Filtered entries
 */
function filterByPhase(entries, phase, stateJson) {
  // Primary filter: by phase field
  const byPhase = entries.filter((e) => e.phase === phase);
  if (byPhase.length > 0) return byPhase;

  // Fallback: use transition timestamps as boundaries
  if (!stateJson?.transitions?.length) return entries;

  const transitions = stateJson.transitions;
  let startTs = null;
  let endTs = null;

  for (let i = 0; i < transitions.length; i++) {
    if (transitions[i].to === phase && verificationStatusIsPass(transitions[i].gate_result, "gate")) {
      startTs = transitions[i].timestamp;
      // Find next transition out of this phase
      for (let j = i + 1; j < transitions.length; j++) {
        if (transitions[j].from === phase) {
          endTs = transitions[j].timestamp;
          break;
        }
      }
      break;
    }
  }

  if (!startTs) return entries; // Can't determine boundaries — return all

  return entries.filter((e) => {
    if (!e.ts) return true;
    if (e.ts < startTs) return false;
    if (endTs && e.ts > endTs) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Rule checkers
// ---------------------------------------------------------------------------

/**
 * Check required_reads rules (file patterns that must have been Read).
 */
function checkRequiredReads(entries, planDir, rules) {
  const results = [];
  if (!rules) return results;

  for (const rule of rules) {
    const pattern = rule.pattern.replace("{plan-dir}", planDir);
    const readPaths = entries
      .filter((e) => e.tool === "Read")
      .flatMap((e) => e.paths || []);

    // Check if any read path matches the pattern
    let matched = false;

    if (pattern.includes("*")) {
      // Glob pattern — check if any KB files were read
      // First, find what files exist that match the pattern
      const globDir = dirname(pattern);
      const globPattern = basename(pattern);
      if (existsSync(globDir)) {
        try {
          const files = readdirSync(globDir).filter((f) =>
            matchGlob(globPattern, f)
          );
          if (files.length === 0) {
            // No KB files exist — vacuously satisfied (legitimate empty KB)
            matched = true;
          } else {
            // Check if at least one KB file was read
            matched = files.some((f) => {
              const fullPath = join(globDir, f);
              return readPaths.some((p) => p === fullPath || p.endsWith("/" + f));
            });
          }
        } catch {
          // RT-REDTEAM-M14: Can't list directory — suspicious, not vacuously satisfied
          matched = false;
        }
      } else {
        // RT-REDTEAM-M14: Directory doesn't exist — WARN, not vacuous pass.
        // An LLM could delete the KB directory to bypass read requirements.
        matched = false;
      }
    } else {
      // Exact path match
      matched = readPaths.some(
        (p) => p === pattern || p.endsWith("/" + basename(pattern))
      );
    }

    const status = matched ? PASS : rule.severity === "warn" ? WARN : FAIL;
    const detail = matched
      ? `${rule.description} — verified`
      : `${rule.description} — not found in trace (${readPaths.length} Read calls total)`;
    results.push(
      withFailureCode(check(`Trace: ${rule.description}`, status, detail), rule.code)
    );
  }

  return results;
}

/**
 * Check minimum discovery calls (Grep/Glob activity).
 */
function checkDiscoveryActivity(entries, rule) {
  if (!rule) return [];

  const tools = rule.tools || ["Grep", "Glob"];
  const count = entries.filter((e) => tools.includes(e.tool)).length;
  const met = count >= rule.minimum;

  const status = met ? PASS : rule.severity === "warn" ? WARN : FAIL;
  const detail = `${count} ${tools.join("/")} calls (minimum: ${rule.minimum})`;
  return [
    withFailureCode(check(`Trace: ${rule.description}`, status, detail), rule.code),
  ];
}

/**
 * Check re-read interval rules (e.g., plan.md every 15 tool calls).
 */
function checkRereadRules(entries, planDir, rules) {
  const results = [];
  if (!rules) return results;

  for (const rule of rules) {
    const targetFile = rule.file.replace("{plan-dir}", planDir);
    const targetBasename = basename(targetFile);
    const maxInterval = rule.max_interval;

    // Walk through entries and check intervals between reads of target file
    let lastReadSeq = 0;
    let maxGap = 0;
    let violated = false;

    for (const entry of entries) {
      const isTargetRead =
        entry.tool === "Read" &&
        (entry.paths || []).some(
          (p) => p === targetFile || p.endsWith("/" + targetBasename)
        );

      if (isTargetRead) {
        const gap = entry.seq - lastReadSeq;
        if (gap > maxGap) maxGap = gap;
        if (lastReadSeq > 0 && gap > maxInterval) violated = true;
        lastReadSeq = entry.seq;
      }
    }

    // Also check gap from last read to end of trace
    if (entries.length > 0 && lastReadSeq > 0) {
      const finalGap = entries[entries.length - 1].seq - lastReadSeq;
      if (finalGap > maxInterval) violated = true;
      if (finalGap > maxGap) maxGap = finalGap;
    }

    // If file was never read at all, that's a violation
    if (lastReadSeq === 0 && entries.length > maxInterval) {
      violated = true;
      maxGap = entries.length;
    }

    const status = violated ? (rule.severity === "warn" ? WARN : FAIL) : PASS;
    const detail = violated
      ? `Max gap: ${maxGap} tool calls without re-reading ${targetBasename} (limit: ${maxInterval})`
      : `${targetBasename} re-read within ${maxInterval}-call intervals (max gap: ${maxGap})`;
    results.push(
      withFailureCode(check(`Trace: ${rule.description}`, status, detail), rule.code)
    );
  }

  return results;
}

/**
 * Check scope creep — writes to files not listed in plan.md.
 */
function checkScopeCreep(entries, planDir, rule) {
  if (!rule || !rule.enabled) return [];

  // Extract planned files from plan.md
  const planPath = rule.source.replace("{plan-dir}", planDir);
  const planContent = readFile(planPath);
  if (!planContent) return []; // No plan.md — skip scope check

  // Find files section
  const sectionPattern = new RegExp(`^(?:${rule.section_pattern})`, "m");
  const sectionMatch = planContent.match(sectionPattern);
  if (!sectionMatch) return []; // No files section — skip

  const sectionStart = sectionMatch.index + sectionMatch[0].length;
  const nextHeading = planContent.indexOf("\n## ", sectionStart);
  const sectionBody =
    nextHeading >= 0
      ? planContent.slice(sectionStart, nextHeading)
      : planContent.slice(sectionStart);

  // Extract file paths from the section (lines starting with - or *)
  const plannedFiles = sectionBody
    .split("\n")
    .filter((l) => l.match(/^\s*[-*]\s+/))
    .map((l) => l.replace(/^\s*[-*]\s+/, "").replace(/`/g, "").trim())
    .filter((l) => l.includes(".") || l.includes("/"));

  if (plannedFiles.length === 0) return []; // No files parsed — skip

  // Find writes outside planned files
  const writePaths = entries
    .filter((e) => e.tool === "Edit" || e.tool === "Write")
    .flatMap((e) => e.paths || []);

  const unplannedWrites = writePaths.filter((wp) => {
    const wpBase = basename(wp);
    return !plannedFiles.some(
      (pf) =>
        wp.endsWith(pf) ||
        wpBase === basename(pf) ||
        pf.includes(wpBase)
    );
  });

  // Filter out plan directory files (state.md, progress.md, etc. are always OK)
  const realUnplanned = unplannedWrites.filter(
    (wp) => !wp.includes("/plans/") && !wp.includes("/.agent/")
  );

  if (realUnplanned.length === 0) {
    return [
      withFailureCode(
        check(`Trace: ${rule.description}`, PASS, "All writes target planned files"),
        rule.code
      ),
    ];
  }

  const status = rule.severity === "warn" ? WARN : FAIL;
  const detail = `${realUnplanned.length} write(s) to unplanned files: ${realUnplanned.slice(0, 3).map(basename).join(", ")}${realUnplanned.length > 3 ? "..." : ""}`;
  return [
    withFailureCode(check(`Trace: ${rule.description}`, status, detail), rule.code),
  ];
}

/**
 * Check required tool types (e.g., at least 1 Bash call in VALIDATE).
 */
function checkRequiredToolTypes(entries, rules) {
  const results = [];
  if (!rules) return results;

  for (const rule of rules) {
    const tools = rule.tools || [];
    const count = entries.filter((e) => tools.includes(e.tool)).length;
    const met = count >= rule.minimum;

    const status = met ? PASS : rule.severity === "warn" ? WARN : FAIL;
    const detail = `${count} ${tools.join("/")} calls (minimum: ${rule.minimum})`;
    results.push(
      withFailureCode(check(`Trace: ${rule.description}`, status, detail), rule.code)
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main audit function
// ---------------------------------------------------------------------------

/**
 * Audit tool trace coverage for a given plan and phase.
 * @param {string} planDir - Absolute path to plan directory
 * @param {string} phase - Phase to audit (EXPLORE, PLAN, EXECUTE, REFLECT, VALIDATE)
 * @returns {{ results: Array, coverage: number, totalRules: number, passedRules: number }}
 */
export function auditTrace(planDir, phase) {
  const allEntries = loadTraceEntries(planDir);
  const stateJson = readStateJson(planDir);
  const entries = filterByPhase(allEntries, phase, stateJson);
  const config = loadTraceRules();
  const phaseRules = config.rules?.[phase];

  const results = [];

  // Check 0: trace file exists and has entries
  if (allEntries.length === 0) {
    results.push(
      withFailureCode(
        check("Trace: trace file", WARN, "tool_trace.jsonl is empty or missing — hook may not be configured"),
        "GATE-TRC-001"
      )
    );
    // Return early with 0% coverage — but as WARN, not FAIL
    return { results, coverage: 0, totalRules: 1, passedRules: 0 };
  }

  results.push(
    check("Trace: trace file", PASS, `${allEntries.length} total entries, ${entries.length} in ${phase} phase`)
  );

  if (!phaseRules) {
    // No rules defined for this phase — pass vacuously
    return { results, coverage: 100, totalRules: 1, passedRules: 1 };
  }

  // Check 1: required reads
  results.push(...checkRequiredReads(entries, planDir, phaseRules.required_reads));

  // Check 2: discovery activity (EXPLORE)
  results.push(...checkDiscoveryActivity(entries, phaseRules.min_discovery_calls));

  // Check 3: re-read intervals (EXECUTE)
  results.push(...checkRereadRules(entries, planDir, phaseRules.reread_rules));

  // Check 4: scope creep (EXECUTE)
  results.push(...checkScopeCreep(entries, planDir, phaseRules.scope_check));

  // Check 5: required tool types (for phases that declare them, including VALIDATE)
  results.push(...checkRequiredToolTypes(entries, phaseRules.required_tool_types));

  // Compute coverage
  const totalRules = results.length;
  const passedRules = results.filter((r) => r.status === PASS).length;
  const coverage = totalRules > 0 ? Math.round((passedRules / totalRules) * 100) : 100;

  return { results, coverage, totalRules, passedRules };
}

// ---------------------------------------------------------------------------
// Antigravity trace import adapter
// ---------------------------------------------------------------------------

/**
 * Convert Antigravity IDE trace format to unified tool_trace.jsonl format.
 * Antigravity traces log LLM calls + tool invocations in their own JSONL format.
 * @param {string} antigravityTracePath - Path to Antigravity trace JSONL
 * @returns {Array<object>} Converted trace entries
 */
export function importAntigravityTrace(antigravityTracePath) {
  if (!existsSync(antigravityTracePath)) return [];
  try {
    const content = readFileSync(antigravityTracePath, "utf-8");
    const entries = content
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    let seq = 0;
    return entries
      .filter((e) => e.type === "tool_use" || e.tool_name || e.name)
      .map((e) => {
        seq++;
        const toolName = e.tool_name || e.name || "Unknown";
        const toolInput = e.tool_input || e.input || {};
        return {
          ts: e.timestamp || e.ts || new Date().toISOString(),
          seq,
          tool: normalizeAntigravityToolName(toolName),
          paths: extractAntigravityPaths(toolName, toolInput),
          pattern: toolInput.pattern || null,
          command: toolName === "bash" ? (toolInput.command || "").slice(0, 200) : null,
          phase: "UNKNOWN", // Antigravity doesn't tag phases — auditor uses timestamps
          plan_dir: null,
          source: "antigravity",
        };
      });
  } catch {
    return [];
  }
}

function normalizeAntigravityToolName(name) {
  const map = {
    read_file: "Read",
    write_file: "Write",
    edit_file: "Edit",
    search: "Grep",
    find_files: "Glob",
    bash: "Bash",
    run_command: "Bash",
  };
  return map[name] || name;
}

function extractAntigravityPaths(toolName, input) {
  if (!input) return [];
  if (input.file_path) return [input.file_path];
  if (input.path) return [input.path];
  if (input.paths) return input.paths;
  return [];
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  const args = process.argv.slice(2);

  // Parse CLI args
  let phaseOverride = null;
  let planDirOverride = null;
  let antigravityImport = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--phase" && args[i + 1]) { phaseOverride = args[++i].toUpperCase(); }
    else if (args[i] === "--plan-dir" && args[i + 1]) { planDirOverride = args[++i]; }
    else if (args[i] === "--import-antigravity" && args[i + 1]) { antigravityImport = args[++i]; }
  }

  // Handle Antigravity import
  if (antigravityImport) {
    const converted = importAntigravityTrace(antigravityImport);
    emitJson(converted, { exitCode: 0 });
  } else {

  // Resolve plan directory
  const { plansDir } = getPaths();
  let planDir;
  if (planDirOverride) {
    planDir = resolve(planDirOverride);
  } else {
    const { planDir: activePlanDir } = resolvePlanTarget(plansDir, { exitOnMissing: true });
    planDir = activePlanDir;
  }

  // Determine phase
  let phase = phaseOverride;
  if (!phase) {
    const stateJson = readStateJson(planDir);
    phase = stateJson?.state || "EXPLORE";
  }

  // Run audit
  printHeader("Tool Trace Audit", `Phase: ${phase}`);

  const { results, coverage, totalRules, passedRules } = auditTrace(planDir, phase);

  printSection("Coverage Results");
  const counts = printResultsWithCodes(results);

  console.log();
  printSection("Summary");
  console.log(`  Coverage: ${coverage}% (${passedRules}/${totalRules} rules satisfied)`);

  const threshold = loadTraceRules().coverage_threshold?.minimum_pct || 60;
  if (coverage < threshold) {
    console.log(`  ⚠️  Below threshold (${threshold}%)`);
  }

  printSummaryWithCodes(counts);
  process.exit(counts.hasFail ? 1 : 0);
  }
}
