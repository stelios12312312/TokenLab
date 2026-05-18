#!/usr/bin/env node
// checklist_runner.mjs — Execute YAML-defined checklists with deterministic checks.
//
// Usage:
//   node checklist_runner.mjs <checklist-name> [--plan <plan-dir>]                    Run a built-in transition checklist
//   node checklist_runner.mjs --file <path.yaml> [--plan <plan-dir>]                  Run a custom checklist file
//   node checklist_runner.mjs --file <path.yaml> --allow-command-checks [--plan <plan-dir>]  Allow command_succeeds in --file checklists
//   node checklist_runner.mjs --list                                                   List available built-in checklists
//
// Check types:
//   file_exists      — verify file at path exists
//   file_not_empty   — file exists and has content beyond templates
//   min_headings     — file has ≥N markdown ## headings
//   contains_string  — file contains a specific string
//   min_lines        — file has ≥N non-empty lines
//   json_field       — JSON file has a specific field
//   command_succeeds — run a shell command, check exit code
//
// Resolves {plan-dir} in paths to an explicit target plan, thread-local target, or plans/.current_plan.
// Zero dependencies — requires Node.js 18+.

import { readFileSync, existsSync, readdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { withFailureCode, sortResults, isFeatureEnabled } from "./lib/determinism.mjs";
import { getPaths, parseSimpleYaml, readPointer, resolveFindingsTruth, resolvePlanTarget } from "./lib/plan_utils.mjs";
import { detectPlanShape } from "./lib/plan_shape.mjs";

const cwd = process.cwd();
const { plansDir } = getPaths(cwd);

// Checklists directory — sibling to this script's parent
const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const skillDir = resolve(scriptDir, "..");
const checklistsDir = join(skillDir, "checklists");

function parseYaml(text) {
  return parseSimpleYaml(text, { collectWarnings: true });
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function resolvePaths(path, planDirName) {
  if (!path) return path;
  return path
    .replace("{plan-dir}", planDirName ? join(plansDir, planDirName) : plansDir)
    .replace("{plans}", plansDir)
    .replace("{knowledge}", join(plansDir, "knowledge"))
    .replace("{cwd}", cwd);
}

const findingsTruthCache = new Map();

function getFindingsTruthForPlan(planDirName) {
  if (!planDirName) return null;
  if (findingsTruthCache.has(planDirName)) return findingsTruthCache.get(planDirName);
  const truth = resolveFindingsTruth(join(plansDir, planDirName));
  findingsTruthCache.set(planDirName, truth);
  return truth;
}

function hasStructuredAssumptionLedger(truth) {
  const assumptions = truth?.json?.ledger?.assumptions;
  return Array.isArray(assumptions) && assumptions.length > 0;
}

const planShapeCache = new Map();

function getPlanShape(planDirName) {
  if (!planDirName) return null;
  if (planShapeCache.has(planDirName)) return planShapeCache.get(planDirName);
  const planDir = join(plansDir, planDirName);
  let goalText = "";
  let plannedFiles = [];
  let intentContract = null;
  try {
    const stateJson = JSON.parse(readFileSync(join(planDir, "state.json"), "utf-8"));
    goalText = stateJson?.goal || "";
    const plannedRaw = stateJson?.planned_files || stateJson?.scope?.declared_files || [];
    if (Array.isArray(plannedRaw)) plannedFiles = plannedRaw;
  } catch { /* state.json may not exist yet for nascent plans */ }
  try {
    intentContract = JSON.parse(readFileSync(join(planDir, "intent_contract.json"), "utf-8"));
  } catch { /* optional */ }
  if (!plannedFiles.length) {
    try {
      const planContent = readFileSync(join(planDir, "plan.md"), "utf-8");
      const filesSection = planContent.match(/##\s+Files\s+[Tt]o\s+[Mm]odify\s*\n([\s\S]*?)(?=\n##|$)/);
      if (filesSection) {
        plannedFiles = (filesSection[1].match(/^\s*[-*]\s+`?([^`\s]+)`?/gm) || [])
          .map((line) => line.replace(/^\s*[-*]\s+`?/, "").replace(/`?\s*$/, "").trim())
          .filter(Boolean);
      }
    } catch { /* plan.md may not exist */ }
  }
  const shape = detectPlanShape({ goalText, plannedFiles, intentContract });
  planShapeCache.set(planDirName, shape);
  return shape;
}

function shapeAppliesToItem(item, shape) {
  const required = Array.isArray(item.required_for_shapes) ? item.required_for_shapes : null;
  if (!required || required.length === 0) return true; // applies to all shapes
  if (!shape || !shape.primary) return true; // can't determine — apply (safer default)
  return required.includes(shape.primary);
}

function hasStructuredAssumptionProbe(truth) {
  const assumptions = truth?.json?.ledger?.assumptions;
  if (!Array.isArray(assumptions)) return false;
  return assumptions.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const status = String(entry.status || "").toUpperCase();
    return status === "VERIFIED" || status === "VIOLATED";
  });
}

// ---------------------------------------------------------------------------
// Check implementations
// ---------------------------------------------------------------------------

function runCheck(item, planDirName) {
  const check = item.check;
  const path = resolvePaths(item.path, planDirName);
  const skipIfPath = resolvePaths(item.skip_if_path, planDirName);
  const id = item.id || "unknown";

  if (
    skipIfPath
    && typeof item.skip_if_string === "string"
    && item.skip_if_string.trim()
    && existsSync(skipIfPath)
  ) {
    const skipContent = readFileSync(skipIfPath, "utf-8");
    if (skipContent.includes(item.skip_if_string)) {
      return {
        id,
        name: item.description || `Conditional skip for ${item.check}`,
        status: "PASS",
        detail: `Skipped because "${item.skip_if_string}" was acknowledged in ${skipIfPath}`,
        code: "GATE-CHK-000",
      };
    }
  }

  switch (check) {
    case "findings_effective_populated": {
      const truth = getFindingsTruthForPlan(planDirName);
      const hasContent = (truth?.effective?.findingCount || 0) > 0 ||
        (!!truth?.findingsContent && !truth.findingsContent.includes("To be populated during EXPLORE"));
      const source = truth?.source === "json" ? "findings_ledger.json" : "findings.md";
      return {
        id,
        name: item.description || "Effective findings source has been populated",
        status: hasContent ? "PASS" : (item.severity === "warn" ? "WARN" : "FAIL"),
        detail: hasContent ? `Using populated findings from ${source}` : "No populated findings found in findings_ledger.json or findings.md",
        code: "GATE-CHK-013",
      };
    }

    case "findings_effective_min_count": {
      const truth = getFindingsTruthForPlan(planDirName);
      const count = truth?.effective?.findingCount || 0;
      const min = item.min || 1;
      const source = truth?.source === "json" ? "findings_ledger.json" : "findings.md";
      return {
        id,
        name: item.description || `Effective findings source has at least ${min} findings`,
        status: count >= min ? "PASS" : (item.severity === "warn" ? "WARN" : "FAIL"),
        detail: `Found ${count} finding(s) in ${source}, need ≥${min}`,
        code: "GATE-CHK-014",
      };
    }

    case "findings_effective_field": {
      const truth = getFindingsTruthForPlan(planDirName);
      let satisfied = false;
      let detail = "Structured findings requirement not satisfied";
      const source = truth?.source === "json" ? "findings_ledger.json" : "findings.md";

      switch (item.field) {
        case "root_cause":
          satisfied = truth?.effective?.hasRootCause === true;
          detail = satisfied ? `Root cause documented in ${source}` : "Root cause not found in findings_ledger.json or findings.md";
          break;
        case "adjacency":
          satisfied = truth?.effective?.hasAdjacency === true;
          detail = satisfied ? `Adjacency documented in ${source}` : "Adjacency not found in findings_ledger.json or findings.md";
          break;
        case "assumption_ledger":
          satisfied = hasStructuredAssumptionLedger(truth) || (truth?.findingsContent || "").includes("Assumption Ledger");
          detail = satisfied ? `Assumption ledger found in ${source}` : "Assumption ledger not found in findings_ledger.json or findings.md";
          break;
        case "assumption_probe":
          satisfied = hasStructuredAssumptionProbe(truth) || /\b(?:VERIFIED|VIOLATED)\b/.test(truth?.findingsContent || "");
          detail = satisfied ? `Assumption probe results found in ${source}` : "No VERIFIED or VIOLATED assumption probe found in findings_ledger.json or findings.md";
          break;
        default:
          detail = `Unsupported findings_effective_field: ${item.field}`;
      }

      return {
        id,
        name: item.description || `Effective findings field: ${item.field}`,
        status: satisfied ? "PASS" : (item.severity === "warn" ? "WARN" : "FAIL"),
        detail,
        code: "GATE-CHK-015",
      };
    }

    case "file_exists": {
      const exists = path && existsSync(path);
      return {
        id,
        name: item.description || `File exists: ${item.path}`,
        status: exists ? "PASS" : (item.severity === "warn" ? "WARN" : "FAIL"),
        detail: exists ? `Found: ${path}` : `Missing: ${path}`,
        code: "GATE-CHK-001",
      };
    }

    case "file_not_empty": {
      if (!path || !existsSync(path)) {
        return {
          id,
          name: item.description || `File not empty: ${item.path}`,
          status: item.severity === "warn" ? "WARN" : "FAIL",
          detail: `File not found: ${path}`,
          code: "GATE-CHK-002",
        };
      }
      const content = readFileSync(path, "utf-8");
      const lines = content.split("\n").filter(
        (l) => l.trim() && !l.startsWith("#") && !l.startsWith("*") && !l.startsWith("---")
      );
      const hasContent = lines.length > 0;
      return {
        id,
        name: item.description || `File not empty: ${item.path}`,
        status: hasContent ? "PASS" : (item.severity === "warn" ? "WARN" : "FAIL"),
        detail: hasContent ? `${lines.length} content line(s)` : "File is empty or only contains boilerplate",
        code: "GATE-CHK-002",
      };
    }

    case "min_headings": {
      if (!path || !existsSync(path)) {
        return {
          id,
          name: item.description || `Min headings in ${item.path}`,
          status: item.severity === "warn" ? "WARN" : "FAIL",
          detail: `File not found: ${path}`,
          code: "GATE-CHK-003",
        };
      }
      const content = readFileSync(path, "utf-8");
      const headings = (content.match(/^## /gm) || []).length;
      const min = item.min || 1;
      return {
        id,
        name: item.description || `At least ${min} ## headings in ${item.path}`,
        status: headings >= min ? "PASS" : (item.severity === "warn" ? "WARN" : "FAIL"),
        detail: `Found ${headings} heading(s), required ≥${min}`,
        code: "GATE-CHK-003",
      };
    }

    case "contains_string": {
      if (!path || !existsSync(path)) {
        return {
          id,
          name: item.description || `Contains "${item.string}" in ${item.path}`,
          status: item.severity === "warn" ? "WARN" : "FAIL",
          detail: `File not found: ${path}`,
          code: "GATE-CHK-004",
        };
      }
      const content = readFileSync(path, "utf-8");
      const found = content.includes(item.string);
      return {
        id,
        name: item.description || `Contains "${item.string}" in ${item.path}`,
        status: found ? "PASS" : (item.severity === "warn" ? "WARN" : "FAIL"),
        detail: found ? `Found "${item.string}"` : `"${item.string}" not found`,
        code: "GATE-CHK-004",
      };
    }

    case "contains_any_string": {
      if (!path || !existsSync(path)) {
        return {
          id,
          name: item.description || `Contains any configured string in ${item.path}`,
          status: item.severity === "warn" ? "WARN" : "FAIL",
          detail: `File not found: ${path}`,
          code: "GATE-CHK-004",
        };
      }
      const content = readFileSync(path, "utf-8");
      const candidates = Array.isArray(item.include) ? item.include.filter(Boolean) : [];
      const matched = candidates.find((candidate) => content.includes(candidate));
      return {
        id,
        name: item.description || `Contains any configured string in ${item.path}`,
        status: matched ? "PASS" : (item.severity === "warn" ? "WARN" : "FAIL"),
        detail: matched ? `Found "${matched}"` : `None of [${candidates.join(", ")}] found`,
        code: "GATE-CHK-004",
      };
    }

    case "not_contains_string": {
      if (!path || !existsSync(path)) {
        return {
          id,
          name: item.description || `Does not contain "${item.string}" in ${item.path}`,
          status: "PASS",
          detail: `File not found — check passes vacuously`,
          code: "GATE-CHK-005",
        };
      }
      const content = readFileSync(path, "utf-8");
      const found = content.includes(item.string);
      return {
        id,
        name: item.description || `Does not contain "${item.string}" in ${item.path}`,
        status: found ? (item.severity === "warn" ? "WARN" : "FAIL") : "PASS",
        detail: found ? `Found "${item.string}" — content still at template` : `Template text not found — content has been filled in`,
        code: "GATE-CHK-005",
      };
    }

    case "min_lines": {
      if (!path || !existsSync(path)) {
        return {
          id,
          name: item.description || `Min lines in ${item.path}`,
          status: item.severity === "warn" ? "WARN" : "FAIL",
          detail: `File not found: ${path}`,
          code: "GATE-CHK-006",
        };
      }
      const content = readFileSync(path, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim()).length;
      const min = item.min || 1;
      return {
        id,
        name: item.description || `At least ${min} non-empty lines in ${item.path}`,
        status: lines >= min ? "PASS" : (item.severity === "warn" ? "WARN" : "FAIL"),
        detail: `Found ${lines} line(s), required ≥${min}`,
        code: "GATE-CHK-006",
      };
    }

    case "json_field": {
      if (!path || !existsSync(path)) {
        return {
          id,
          name: item.description || `JSON field "${item.field}" in ${item.path}`,
          status: item.severity === "warn" ? "WARN" : "FAIL",
          detail: `File not found: ${path}`,
          code: "GATE-CHK-007",
        };
      }
      try {
        const data = JSON.parse(readFileSync(path, "utf-8"));
        const hasField = item.field in data;
        return {
          id,
          name: item.description || `JSON field "${item.field}" in ${item.path}`,
          status: hasField ? "PASS" : (item.severity === "warn" ? "WARN" : "FAIL"),
          detail: hasField ? `Field "${item.field}" = ${JSON.stringify(data[item.field])}` : `Field "${item.field}" missing`,
          code: "GATE-CHK-007",
        };
      } catch (e) {
        return {
          id,
          name: item.description || `JSON field "${item.field}" in ${item.path}`,
          status: "FAIL",
          detail: `JSON parse error: ${e.message}`,
          code: "GATE-CHK-007",
        };
      }
    }

    case "command_succeeds": {
      // SECURITY NOTE (D-022): `cmd` comes directly from the checklist YAML.
      // Built-in checklists (checklists/) are version-controlled and trusted.
      // For --file checklists (external/user-supplied YAML), command_succeeds is
      // blocked by default to prevent command injection. Pass --allow-command-checks
      // to opt in after reviewing the checklist.
      if (isExternalFile && !allowCommandChecks) {
        return {
          id,
          name: item.description || "Command check",
          status: item.severity === "warn" ? "WARN" : "FAIL",
          detail: "command_succeeds blocked for --file checklist (pass --allow-command-checks to enable). " +
                  "FAIL prevents silent gate bypass when checklists rely on command checks.",
          code: "GATE-CHK-008",
        };
      }
      const cmd = item.command;
      if (!cmd) {
        return { id, name: item.description || "Command check", status: "FAIL", detail: "No command specified", code: "GATE-CHK-008" };
      }
      // RT6-C2: Command allowlist — only permit 'node .agent/skills/iterative-planner/scripts/*.mjs'.
      // Without this, a modified checklist YAML could execute arbitrary binaries.
      const cmdTrimmed = cmd.trim();
      const tokens = cmdTrimmed.split(/\s+/);
      const ALLOWED_PREFIX = ".agent/skills/iterative-planner/scripts/";
      let cmdBlocked = false;
      let blockReason = "";
      if (tokens[0] !== "node") {
        cmdBlocked = true;
        blockReason = `Command blocked (RT6-C2): must start with 'node'. Got: ${tokens[0]}`;
      } else if (!tokens[1] || !tokens[1].startsWith(ALLOWED_PREFIX) || !tokens[1].endsWith(".mjs")) {
        cmdBlocked = true;
        blockReason = `Command blocked (RT6-C2): script must be under ${ALLOWED_PREFIX}*.mjs. Got: ${tokens[1] || "(none)"}`;
      }
      if (!cmdBlocked) {
        for (let ti = 1; ti < tokens.length; ti++) {
          const tok = tokens[ti];
          if (tok.includes("..")) {
            cmdBlocked = true;
            blockReason = `Command blocked (RT6-C2): path traversal ("..") in token: ${tok}`;
            break;
          }
          if (/[;|&`$(){}!<>]/.test(tok)) {
            cmdBlocked = true;
            blockReason = `Command blocked (RT6-C2): shell metacharacter in token: ${tok}`;
            break;
          }
        }
      }
      if (cmdBlocked) {
        return { id, name: item.description || "Command check", status: "FAIL", detail: blockReason, code: "GATE-CHK-008" };
      }
      // Tokenize command string into executable + args for spawnSync (no shell)
      const parts = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
      let exe = parts[0];
      const cmdArgs = parts.slice(1).map(a => a.replace(/^["']|["']$/g, ""));
      // Resolve "node" to process.execPath so commands work even when node isn't on PATH
      // (common in IDE extensions, macOS GUI shells, nvm/fnm environments)
      if (exe === "node") exe = process.execPath;
      if (!exe) {
        return { id, name: item.description || "Command check", status: "FAIL", detail: "Empty command after tokenization", code: "GATE-CHK-008" };
      }
      const proc = spawnSync(exe, cmdArgs, { cwd, stdio: "pipe", timeout: 30000, encoding: "utf-8" });
      if (proc.status === 0) {
        return {
          id,
          name: item.description || `Command: ${cmd}`,
          status: "PASS",
          detail: `Command exited 0`,
          code: "GATE-CHK-008",
        };
      } else {
        return {
          id,
          name: item.description || `Command: ${cmd}`,
          status: item.severity === "warn" ? "WARN" : "FAIL",
          detail: `Command failed (exit ${proc.status}): ${(proc.stderr || "").trim().slice(0, 200)}`,
          code: "GATE-CHK-008",
        };
      }
    }

    default:
      return {
        id,
        name: item.description || `Unknown check: ${check}`,
        status: "WARN",
        detail: `Unknown check type: ${check}`,
      };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`Usage: node checklist_runner.mjs <checklist-name>
       node checklist_runner.mjs <checklist-name> [--plan <plan-dir>]
       node checklist_runner.mjs --file <path.yaml> [--plan <plan-dir>]
       node checklist_runner.mjs --file <path.yaml> --allow-command-checks [--plan <plan-dir>]
       node checklist_runner.mjs --list

Run deterministic checklists for iterative planner gates.

Built-in checklists are in: ${checklistsDir}
Custom checklists can be run with --file.

Note: command_succeeds checks are disabled for --file checklists unless
      --allow-command-checks is passed (security opt-in).

Exit code 0 = all PASS, 1 = any FAIL. WARN items do not fail.`);
}

const args = process.argv.slice(2);
const allowCommandChecks = args.includes("--allow-command-checks");
let planOverride = null;
const filteredArgs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--allow-command-checks") continue;
  if (args[i] === "--plan") {
    planOverride = args[i + 1] || null;
    i++;
    continue;
  }
  filteredArgs.push(args[i]);
}

if (filteredArgs.length === 0 || filteredArgs[0] === "--help" || filteredArgs[0] === "help") {
  printUsage();
  process.exit(0);
}

if (filteredArgs[0] === "--list") {
  if (!existsSync(checklistsDir)) {
    console.log("No checklists directory found.");
    process.exit(0);
  }
  const files = readdirSync(checklistsDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  console.log(`Available checklists (${files.length}):`);
  for (const f of files) {
    const name = f.replace(/\.(yaml|yml)$/, "");
    const content = readFileSync(join(checklistsDir, f), "utf-8");
    const parsed = parseYaml(content);
    console.log(`  ${name.padEnd(25)} ${parsed.name || "(no name)"}`);
  }
  process.exit(0);
}

// Determine checklist file
let checklistPath;
let isExternalFile = false;
if (filteredArgs[0] === "--file") {
  checklistPath = filteredArgs[1];
  isExternalFile = true;
  if (!checklistPath) {
    console.error("ERROR: --file requires a path argument.");
    process.exit(1);
  }
} else {
  // Look in built-in checklists dir
  const name = filteredArgs[0];
  checklistPath = join(checklistsDir, `${name}.yaml`);
  if (!existsSync(checklistPath)) {
    checklistPath = join(checklistsDir, `${name}.yml`);
  }
}

if (!existsSync(checklistPath)) {
  console.error(`ERROR: Checklist not found: ${checklistPath}`);
  console.error(`  Use --list to see available checklists.`);
  process.exit(1);
}

// Read and parse
const yamlText = readFileSync(checklistPath, "utf-8");
const checklist = parseYaml(yamlText);

// Surface YAML parser warnings — these indicate lines that were not parsed,
// which could mean checklist checks are silently missing.
if (checklist.warnings.length > 0) {
  console.error(`WARNING: YAML parser encountered ${checklist.warnings.length} unparsed line(s) in ${checklistPath}:`);
  for (const w of checklist.warnings) {
    console.error(`  ⚠️  ${w}`);
  }
  console.error("  These lines were skipped. If they contain checks, those checks will NOT run.");
  console.error("");
}

// Resolve plan dir
const target = resolvePlanTarget(plansDir, { exitOnMissing: false, plan: planOverride });
const planDirName = target.planDirName;

if (planDirName) {
  process.env._PLANNER_PLAN_TARGET = planDirName;
}

if (!planDirName) {
  console.error("WARNING: No target plan found. {plan-dir} paths will not resolve.");
  console.error("  Create a plan with bootstrap.mjs first, pass --plan, or use absolute paths in your checklist.");
}

// Run checks
console.log(`\n┌──────────────────────────────────────────────────────┐`);
console.log(`│  CHECKLIST: ${(checklist.name || filteredArgs[0]).padEnd(40)}│`);
if (planDirName) {
  console.log(`│  Plan: ${planDirName.padEnd(45)}│`);
}
console.log(`└──────────────────────────────────────────────────────┘\n`);
if (planDirName && target.source && target.source !== "pointer") {
  console.log(`  Target source: ${target.source}`);
  const pointerPlanDirName = readPointer(plansDir);
  if (pointerPlanDirName && pointerPlanDirName !== planDirName) {
    console.log(`  Pointer: plans/.current_plan → ${pointerPlanDirName}`);
  }
  console.log();
}

// F-011 FIX: Zero items parsed means the YAML was not understood — treat as FAIL
if (checklist.items.length === 0) {
  console.error("  ❌ ERROR: No checklist items were parsed. The YAML may have unsupported syntax.");
  console.error("     Ensure items use 2-space indentation with 4-space properties.");
  console.log(`\n  ══ RESULT: ❌ BLOCKED — 0 items parsed (checklist is effectively empty) ══`);
  process.exit(1);
}

// F-008 FIX: Parser warnings with items present means some items were silently dropped.
// Treat as FAIL to prevent critical checks from being silently skipped.
if (checklist.warnings.length > 0) {
  console.error("  ❌ ERROR: Some checklist lines were not parsed. Checks may be silently missing.");
  console.error("     Fix the YAML formatting issues above before proceeding.");
  console.log(`\n  ══ RESULT: ❌ BLOCKED — ${checklist.warnings.length} unparsed line(s) detected ══`);
  process.exit(1);
}

let hasFail = false;
let passCount = 0;
let warnCount = 0;
let failCount = 0;

const planShape = getPlanShape(planDirName);
if (planShape) {
  console.log(`  Plan shape: ${planShape.primary} (source: ${planShape.source})`);
  console.log();
}

for (const item of checklist.items) {
  if (!shapeAppliesToItem(item, planShape)) {
    passCount++;
    const allowed = (item.required_for_shapes || []).join(", ");
    console.log(`  ✅ [PASS] ${item.description || item.id} — not required for ${planShape.primary} shape (required for: ${allowed})`);
    continue;
  }
  const result = runCheck(item, planDirName);
  const icon = result.status === "PASS" ? "✅" : result.status === "FAIL" ? "❌" : "⚠️";
  const codeStr = result.code ? ` [${result.code}]` : "";
  console.log(`  ${icon} [${result.status}]${codeStr} ${result.name}`);
  if (result.detail) {
    console.log(`          ${result.detail}`);
  }

  if (result.status === "PASS") passCount++;
  else if (result.status === "WARN") warnCount++;
  else { failCount++; hasFail = true; }
}

console.log();
console.log(`  Summary: ${passCount} PASS, ${warnCount} WARN, ${failCount} FAIL`);
console.log();

if (hasFail) {
  console.log(`  ══ RESULT: ❌ BLOCKED — fix FAIL items before proceeding ══`);
  process.exit(1);
} else {
  console.log(`  ══ RESULT: ✅ ALL CHECKS PASSED ══`);
  process.exit(0);
}
