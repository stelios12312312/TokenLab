// checklist_runner.mjs — YAML checklist executor for iterative planner gates.
//
// Extracted from transition.mjs to reduce orchestrator size and prevent
// LLM context-window drift during modifications.
//
// Security controls preserved:
//   AV-3:  Path traversal guard (resolved path must stay within cwd)
//   AV-8:  Command injection allowlist (only node .../scripts/*.mjs)
//   AV-17: Checklist integrity hashing (baseline verification)
//   RT-AUDIT-005: No lazy baseline recording (missing baseline = FAIL)
//
// Zero dependencies — Node.js 18+.

import { readFileSync, existsSync, realpathSync } from "fs";
import { join, resolve } from "path";
import { createHash } from "crypto";
import { execSync } from "child_process";
import {
  readFile, PASS, WARN, FAIL, check, parseSimpleYaml,
  resolveFindingsTruth,
} from "./plan_utils.mjs";
import { assumptionStatusIsResolved } from "./session_obligations.mjs";

// ---------------------------------------------------------------------------
// Checklist integrity (AV-17)
// ---------------------------------------------------------------------------

let _checklistHashes = null;
const findingsTruthCache = new Map();

/**
 * Load known-good checklist hashes from config/.checklist_integrity.
 * @param {string} skillPath - Root of the iterative-planner skill directory
 */
function getChecklistHashes(skillPath) {
  if (_checklistHashes) return _checklistHashes;
  const hashPath = join(skillPath, "config", ".checklist_integrity");
  try {
    _checklistHashes = JSON.parse(readFileSync(hashPath, "utf-8"));
  } catch {
    _checklistHashes = {};
  }
  return _checklistHashes;
}

/**
 * Verify a checklist's content hash against the pre-computed baseline.
 * RT-AUDIT-005: Missing baselines are FAIL (no lazy recording).
 */
function verifyChecklistHash(skillPath, checklistName, content) {
  // RT10-C2: Full 32-char hash; backwards compat with old 16-char baselines
  const fullHash = createHash("sha256").update(content).digest("hex").slice(0, 32);
  const hashes = getChecklistHashes(skillPath);
  if (!hashes[checklistName]) {
    return { expected: "(missing)", actual: fullHash, intact: false };
  }
  const stored = hashes[checklistName];
  const match = stored.length === 32 ? fullHash === stored : fullHash.slice(0, 16) === stored;
  return { expected: stored, actual: fullHash, intact: match };
}

function getFindingsTruthForPlan(plansDir, planDirName) {
  if (!planDirName) return null;
  const cacheKey = `${plansDir}:${planDirName}`;
  if (findingsTruthCache.has(cacheKey)) return findingsTruthCache.get(cacheKey);
  const truth = resolveFindingsTruth(join(plansDir, planDirName));
  findingsTruthCache.set(cacheKey, truth);
  return truth;
}

function hasStructuredAssumptionLedger(truth) {
  const assumptions = truth?.json?.ledger?.assumptions;
  return Array.isArray(assumptions) && assumptions.length > 0;
}

function hasStructuredAssumptionProbe(truth) {
  const assumptions = truth?.json?.ledger?.assumptions;
  if (!Array.isArray(assumptions)) return false;
  return assumptions.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return assumptionStatusIsResolved(entry.status);
  });
}

// ---------------------------------------------------------------------------
// Checklist executor
// ---------------------------------------------------------------------------

function checklistCommandTimeoutMs(item) {
  const raw = Number(item?.timeout);
  return Number.isFinite(raw) && raw > 0 ? raw : 30000;
}

function checklistFailureCode(item = {}, detail = "") {
  if (/path traversal|symlink|integrity|tamper|invalid checklist name/i.test(detail)) return "GATE-CHK-010";
  if (item.check === "command_succeeds") return "GATE-CHK-008";
  if (item.check === "json_field_equals") return "GATE-CHK-011";
  return "GATE-CHK-001";
}

function codedChecklistCheck(name, status, detail, item = {}) {
  const result = check(name, status, detail);
  result.code = checklistFailureCode(item, detail);
  if (result.code === "GATE-CHK-008" && item.command) result.next = item.command;
  return result;
}

/**
 * Run a YAML checklist and return an array of check results.
 *
 * @param {string} checklistName - Gate name (e.g. "explore-to-plan")
 * @param {string} planDirName   - Active plan directory name (or null)
 * @param {object} paths         - { skillPath, plansDir, knowledgeDir, cwd }
 * @returns {Array<{ name: string, status: string, detail: string }>}
 */
export function runChecklist(checklistName, planDirName, { skillPath, plansDir, knowledgeDir, cwd, refreshSnapshot = null }) {
  const results = [];
  const checklistsDir = join(skillPath, "checklists");
  // RT5-M5: Validate checklistName to prevent path traversal (../ injection)
  if (!/^[a-z0-9_-]+$/.test(checklistName)) {
    results.push(codedChecklistCheck(`Checklist ${checklistName}`, FAIL, "Invalid checklist name — must be [a-z0-9_-] only"));
    return results;
  }
  let checklistPath = join(checklistsDir, `${checklistName}.yaml`);
  if (!existsSync(checklistPath)) {
    checklistPath = join(checklistsDir, `${checklistName}.yml`);
  }
  if (!existsSync(checklistPath)) {
    results.push(check(`Checklist ${checklistName}`, WARN, "Checklist file not found"));
    return results;
  }

  try {
    const text = readFileSync(checklistPath, "utf-8");

    // AV-17 + RT-REDTEAM-H4: Verify checklist integrity before running checks.
    // If integrity fails, return IMMEDIATELY — do NOT execute items from a tampered checklist.
    // A modified checklist could have all security checks removed.
    const integrityCheck = verifyChecklistHash(skillPath, checklistName, text);
    if (!integrityCheck.intact) {
      results.push(codedChecklistCheck(
        `Checklist integrity (${checklistName})`,
        FAIL,
        `Checklist file modified since baseline (expected ${integrityCheck.expected}, got ${integrityCheck.actual}). Re-run migration to update baseline.`
      ));
      return results; // RT-REDTEAM-H4: Do NOT execute items from tampered checklist
    }

    const checklist = parseSimpleYaml(text);
    const planDir = planDirName ? join(plansDir, planDirName) : plansDir;
    const transientStatePath = join(planDir, "state.json");
    const readChecklistJson = (jsonPath) => {
      const parsed = JSON.parse(readFileSync(jsonPath, "utf-8"));
      if (jsonPath === transientStatePath && refreshSnapshot?.closeSignals) {
        return {
          ...parsed,
          close_signals: {
            ...refreshSnapshot.closeSignals,
            ontology: refreshSnapshot.ontology,
          },
        };
      }
      return parsed;
    };

    for (const item of checklist.items) {
      const path = (item.path || "")
        .replace("{plan-dir}", planDir)
        .replace("{plans}", plansDir)
        .replace("{knowledge}", knowledgeDir)
        .replace("{cwd}", cwd);

      // AV-3: Path traversal guard — resolved path must stay within project directory
      if (path) {
        const resolvedPath = resolve(path);
        if (!resolvedPath.startsWith(cwd)) {
          results.push(codedChecklistCheck(
            item.description || item.id || item.check,
            FAIL,
            `Path traversal blocked: ${resolvedPath} is outside project root ${cwd}`,
            item,
          ));
          continue;
        }
      }

      let status = PASS;
      let detail = "";

      switch (item.check) {
        case "findings_effective_populated": {
          const truth = getFindingsTruthForPlan(plansDir, planDirName);
          const hasContent = (truth?.effective?.findingCount || 0) > 0 ||
            (!!truth?.findingsContent && !truth.findingsContent.includes("To be populated during EXPLORE"));
          const source = truth?.source === "json" ? "findings_ledger.json" : "findings.md";
          status = hasContent ? PASS : (item.severity === "warn" ? WARN : FAIL);
          detail = hasContent ? `Using populated findings from ${source}` : "No populated findings found in findings_ledger.json or findings.md";
          break;
        }
        case "findings_effective_min_count": {
          const truth = getFindingsTruthForPlan(plansDir, planDirName);
          const count = truth?.effective?.findingCount || 0;
          const min = item.min || 1;
          const source = truth?.source === "json" ? "findings_ledger.json" : "findings.md";
          status = count >= min ? PASS : (item.severity === "warn" ? WARN : FAIL);
          detail = `Found ${count} finding(s) in ${source}, need ≥${min}`;
          break;
        }
        case "findings_effective_field": {
          const truth = getFindingsTruthForPlan(plansDir, planDirName);
          const source = truth?.source === "json" ? "findings_ledger.json" : "findings.md";
          switch (item.field) {
            case "root_cause":
              status = truth?.effective?.hasRootCause === true ? PASS : (item.severity === "warn" ? WARN : FAIL);
              detail = status === PASS ? `Root cause documented in ${source}` : "Root cause not found in findings_ledger.json or findings.md";
              break;
            case "adjacency":
              status = truth?.effective?.hasAdjacency === true ? PASS : (item.severity === "warn" ? WARN : FAIL);
              detail = status === PASS ? `Adjacency documented in ${source}` : "Adjacency not found in findings_ledger.json or findings.md";
              break;
            case "assumption_ledger": {
              const satisfied = hasStructuredAssumptionLedger(truth) || (truth?.findingsContent || "").includes("Assumption Ledger");
              status = satisfied ? PASS : (item.severity === "warn" ? WARN : FAIL);
              detail = satisfied ? `Assumption ledger found in ${source}` : "Assumption ledger not found in findings_ledger.json or findings.md";
              break;
            }
            case "assumption_probe": {
              const satisfied = hasStructuredAssumptionProbe(truth) || /\b(?:VERIFIED|VIOLATED)\b/.test(truth?.findingsContent || "");
              status = satisfied ? PASS : (item.severity === "warn" ? WARN : FAIL);
              detail = satisfied ? `Assumption probe results found in ${source}` : "No VERIFIED or VIOLATED assumption probe found in findings_ledger.json or findings.md";
              break;
            }
            default:
              status = item.severity === "warn" ? WARN : FAIL;
              detail = `Unsupported findings_effective_field: ${item.field}`;
          }
          break;
        }
        case "file_exists":
          status = path && existsSync(path) ? PASS : (item.severity === "warn" ? WARN : FAIL);
          detail = existsSync(path) ? "Found" : `Missing: ${path}`;
          break;
        case "file_not_empty": {
          if (!existsSync(path)) {
            status = item.severity === "warn" ? WARN : FAIL;
            detail = "File not found";
          } else {
            const content = readFile(path);
            // RT5-M3: Aligned with plan_utils.fileNotEmpty — markdown list items (* prefix)
            // are substantive content. Previously filtered them out, creating inconsistency.
            const lines = content ? content.split("\n").filter(l => l.trim() && !l.startsWith("#")).length : 0;
            status = lines > 0 ? PASS : (item.severity === "warn" ? WARN : FAIL);
            detail = `${lines} content line(s)`;
          }
          break;
        }
        case "min_headings": {
          if (!existsSync(path)) {
            status = item.severity === "warn" ? WARN : FAIL;
            detail = "File not found";
          } else {
            const content = readFile(path);
            const count = content ? (content.match(/^## /gm) || []).length : 0;
            const min = item.min || 1;
            status = count >= min ? PASS : (item.severity === "warn" ? WARN : FAIL);
            detail = `${count} heading(s), need ≥${min}`;
          }
          break;
        }
        case "contains_string": {
          if (!existsSync(path)) {
            status = item.severity === "warn" ? WARN : FAIL;
            detail = "File not found";
          } else {
            const content = readFile(path);
            const found = content && content.includes(item.string);
            status = found ? PASS : (item.severity === "warn" ? WARN : FAIL);
            detail = found ? `Found "${item.string}"` : `"${item.string}" not found`;
          }
          break;
        }
        case "contains_any_string": {
          if (!existsSync(path)) {
            status = item.severity === "warn" ? WARN : FAIL;
            detail = "File not found";
          } else {
            const content = readFile(path);
            const candidates = Array.isArray(item.include) ? item.include.filter(Boolean) : [];
            const matched = candidates.find((candidate) => content && content.includes(candidate));
            status = matched ? PASS : (item.severity === "warn" ? WARN : FAIL);
            detail = matched
              ? `Found "${matched}"`
              : `None of [${candidates.join(", ")}] found`;
          }
          break;
        }
        case "not_contains_string": {
          if (!existsSync(path)) {
            status = PASS;
            detail = "File not found — passes vacuously";
          } else {
            const content = readFile(path);
            const found = content && content.includes(item.string);
            status = found ? (item.severity === "warn" ? WARN : FAIL) : PASS;
            detail = found ? `Found "${item.string}"` : "Template text cleared";
          }
          break;
        }
        case "min_lines": {
          if (!existsSync(path)) {
            status = item.severity === "warn" ? WARN : FAIL;
            detail = "File not found";
          } else {
            const content = readFile(path);
            const lineCount = content ? content.split("\n").filter(l => l.trim()).length : 0;
            const min = item.min || 1;
            status = lineCount >= min ? PASS : (item.severity === "warn" ? WARN : FAIL);
            detail = `${lineCount} non-empty line(s), need ≥${min}`;
          }
          break;
        }
        case "json_field": {
          if (!existsSync(path)) {
            status = item.severity === "warn" ? WARN : FAIL;
            detail = "File not found";
          } else {
            try {
              const obj = readChecklistJson(path);
              const field = item.field || item.string;
              const keys = field.split(".");
              let val = obj;
              for (const k of keys) {
                val = val?.[k];
              }
              const hasField = val !== undefined && val !== null;
              status = hasField ? PASS : (item.severity === "warn" ? WARN : FAIL);
              detail = hasField ? `Field "${field}" found` : `Field "${field}" missing`;
            } catch (e) {
              status = item.severity === "warn" ? WARN : FAIL;
              detail = `JSON parse error: ${e.message}`;
            }
          }
          break;
        }
        case "json_field_equals": {
          if (!existsSync(path)) {
            status = item.severity === "warn" ? WARN : FAIL;
            detail = "File not found";
          } else {
            try {
              const obj = readChecklistJson(path);
              const field = item.field || item.string;
              const keys = field.split(".");
              let val = obj;
              for (const k of keys) {
                val = val?.[k];
              }
              const expected = item.equals;
              const matches = val === expected;
              status = matches ? PASS : (item.severity === "warn" ? WARN : FAIL);
              detail = matches
                ? `Field "${field}" matches expected value`
                : `Field "${field}" was ${JSON.stringify(val)}; expected ${JSON.stringify(expected)}`;
            } catch (e) {
              status = item.severity === "warn" ? WARN : FAIL;
              detail = `JSON parse error: ${e.message}`;
            }
          }
          break;
        }
        case "command_succeeds": {
          try {
            const cmd = item.command || item.string;
            if (!cmd) {
              status = item.severity === "warn" ? WARN : FAIL;
              detail = "No command specified in checklist item";
            } else {
              // AV-8 + RT-REDTEAM-H2 + M1-FIX: Strict token-based command allowlist.
              // M1-FIX: Replaced regex-based allowlist with strict string tokenization.
              // Regex patterns can be bypassed with creative whitespace, unicode, or
              // backtracking-induced catastrophic matching. Token-based validation is
              // unambiguous: split on whitespace, validate each token individually.
              const cmdTrimmed = cmd.trim();
              const tokens = cmdTrimmed.split(/\s+/);
              const ALLOWED_PREFIX = ".agent/skills/iterative-planner/scripts/";

              let cmdBlocked = false;
              let blockReason = "";

              // Token 0 must be exactly "node"
              if (tokens[0] !== "node") {
                cmdBlocked = true;
                blockReason = `Command blocked (AV-8): must start with 'node'. Got: ${tokens[0]}`;
              }
              // Token 1 must be a .mjs file under the allowed prefix
              else if (!tokens[1] || !tokens[1].startsWith(ALLOWED_PREFIX) || !tokens[1].endsWith(".mjs")) {
                cmdBlocked = true;
                blockReason = `Command blocked (AV-8): script must be under ${ALLOWED_PREFIX}*.mjs. Got: ${tokens[1] || "(none)"}`;
              }
              // Check ALL tokens for path traversal and dangerous flags
              if (!cmdBlocked) {
                for (let ti = 1; ti < tokens.length; ti++) {
                  const tok = tokens[ti];
                  if (tok.includes("..")) {
                    cmdBlocked = true;
                    blockReason = `Command blocked (RT-REDTEAM-H2): path traversal ("..") in token: ${tok}`;
                    break;
                  }
                  // RT-REDTEAM-H2: Block all flags except a narrow allowlist of safe, side-effect-free
                  // script-level flags (not Node.js flags that alter the runtime environment).
                  const ALLOWED_SCRIPT_FLAGS = new Set(["--self-test", "--json", "--quick", "--list", "--validate"]);
                  if (ti >= 2 && tok.startsWith("-") && !ALLOWED_SCRIPT_FLAGS.has(tok)) {
                    cmdBlocked = true;
                    blockReason = `Command blocked (RT-REDTEAM-H2): node flags (-*) not allowed: ${tok}`;
                    break;
                  }
                  // M1-FIX: Reject tokens with shell metacharacters that could enable injection
                  if (/[;|&`$(){}!<>]/.test(tok)) {
                    cmdBlocked = true;
                    blockReason = `Command blocked (M1-FIX): shell metacharacter in token: ${tok}`;
                    break;
                  }
                }
              }

              if (cmdBlocked) {
                status = FAIL;
                detail = blockReason;
              } else {
                // RT-RCH-SYMLINK: Resolve symlinks before execution.
                // An LLM could create a symlink at the allowed path pointing to
                // arbitrary code. Verify the resolved path stays within the skill dir.
                const scriptMatch = cmdTrimmed.match(/^node\s+(\S+)/);
                if (scriptMatch) {
                  const scriptRelative = scriptMatch[1];
                  const scriptAbsolute = resolve(cwd, scriptRelative);
                  if (existsSync(scriptAbsolute)) {
                    try {
                      const realScript = realpathSync(scriptAbsolute);
                      const realSkillDir = realpathSync(resolve(cwd, ".agent", "skills", "iterative-planner"));
                      if (!realScript.startsWith(realSkillDir)) {
                        status = FAIL;
                        detail = `Command blocked (RT-RCH-SYMLINK): resolved path escapes skill directory — possible symlink attack. Real: ${realScript}`;
                        break;
                      }
                    } catch (e) {
                      // realpathSync failed — script doesn't exist or broken symlink
                      status = FAIL;
                      detail = `Command blocked (RT-RCH-SYMLINK): cannot resolve script path — ${e.message}`;
                      break;
                    }
                  }
                }
                // RT10-H4: Re-validate symlink IMMEDIATELY before execution (TOCTOU defense).
                // Between the initial symlink check and execSync(), the symlink target
                // could be swapped to point to malicious code.
                if (scriptMatch) {
                  const scriptAbsoluteRecheck = resolve(cwd, scriptMatch[1]);
                  try {
                    const realScriptRecheck = realpathSync(scriptAbsoluteRecheck);
                    const realSkillDirRecheck = realpathSync(resolve(cwd, ".agent", "skills", "iterative-planner"));
                    if (!realScriptRecheck.startsWith(realSkillDirRecheck)) {
                      status = FAIL;
                      detail = `Command blocked (RT10-H4): symlink target changed between check and exec — possible TOCTOU attack`;
                      break;
                    }
                  } catch (e2) {
                    status = FAIL;
                    detail = `Command blocked (RT10-H4): symlink re-validation failed — ${e2.message}`;
                    break;
                  }
                }
                execSync(cmd, { cwd, stdio: "pipe", timeout: checklistCommandTimeoutMs(item) });
                status = PASS;
                detail = `Command succeeded: ${cmd}`;
              }
            }
          } catch (e) {
            status = item.severity === "warn" ? WARN : FAIL;
            detail = `Command failed: ${e.message?.split("\n")[0] || "unknown error"}`;
          }
          break;
        }
        default:
          status = WARN;
          detail = `Unsupported check type: ${item.check}`;
      }

      results.push(codedChecklistCheck(item.description || item.id || item.check, status, detail, item));
    }
  } catch (e) {
    results.push(codedChecklistCheck(`Checklist ${checklistName}`, WARN, `Error: ${e.message}`));
  }

  return results;
}
