// Unified task declarations. Projection is one-way and explicitly requested.
// @planner:module task_contract
import { readFileSync, writeFileSync, existsSync, lstatSync, unlinkSync } from "fs";
import { join } from "path";
import { parsePlanJson, projectPlanJsonToMd, detectFirstDuplicateJsonKey } from "./plan_contract.mjs";

export const TASK_CONTRACT_SCHEMA_VERSION = 1;
export const TASK_CONTRACT_FILENAMES = ["task.yaml", "task.yml", "task.json"];
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 40;

function assertSafeTree(value, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error("Task nesting exceeds limit");
  if (["undefined", "function", "symbol", "bigint"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value))) {
    throw new Error("Task values must be JSON-compatible");
  }
  if (!value || typeof value !== "object") return;
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    throw new Error("Task objects must not have inherited fields");
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error("Unsafe key: " + key);
    assertSafeTree(value[key], depth + 1);
  }
}

function parseJsonStrict(raw) {
  if (detectFirstDuplicateJsonKey(raw)) throw new Error("Duplicate JSON key");
  const value = JSON.parse(raw);
  assertSafeTree(value);
  return value;
}

// Bounded YAML subset: block maps/lists, JSON flow values, quoted/plain scalars.
// Aliases, tags, block strings and YAML flow maps are rejected, never discarded.
export function parseYamlSimple(raw) {
  if (typeof raw !== "string") throw new Error("YAML input must be a string");
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error("Task exceeds size limit");
  const trimmed = raw.trim();
  if (!trimmed) return {};
  if (/^[{\[]/.test(trimmed)) return parseJsonStrict(trimmed);
  const tokens = [];
  for (const [i, line] of raw.split(/\r?\n/).entries()) {
    if (/^[ \t]*\t/.test(line)) throw new Error("Tabs in indentation at line " + (i + 1));
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    tokens.push({ indent: line.length - line.trimStart().length, text: line.trim(), line: i + 1 });
  }
  let cursor = 0;
  function scalar(input, depth = 0) {
    if (depth > MAX_DEPTH) throw new Error("Task nesting exceeds limit");
    let quote = null, end = input.length;
    for (let i = 0; i < input.length; i++) {
      const c = input[i];
      if (quote === '"' && c === "\\") { i++; continue; }
      if (quote === "'" && c === "'" && input[i + 1] === "'") { i++; continue; }
      if (quote) { if (c === quote) quote = null; }
      else if ((c === '"' || c === "'") && (i === 0 || /[\s\[,]/.test(input[i - 1]))) quote = c;
      else if (c === "#" && (i === 0 || /\s/.test(input[i - 1]))) { end = i; break; }
    }
    if (quote) throw new Error("Unterminated quoted scalar");
    const v = input.slice(0, end).trim();
    if (!v) return null;
    if (v.startsWith('"') || v.startsWith("{")) return parseJsonStrict(v);
    if (v.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/.test(v)) throw new Error("Invalid single-quoted scalar");
      return v.slice(1, -1).replaceAll("''", "'");
    }
    if (v.startsWith("[")) {
      if (!v.endsWith("]")) throw new Error("Unclosed flow list");
      const inner = v.slice(1, -1);
      if (!inner.trim()) return [];
      const parts = [];
      let start = 0, nesting = 0, q = null;
      for (let i = 0; i < inner.length; i++) {
        const c = inner[i];
        if (q === '"' && c === "\\") { i++; continue; }
        if (q === "'" && c === "'" && inner[i + 1] === "'") { i++; continue; }
        if (q) { if (c === q) q = null; continue; }
        if (c === '"' || c === "'") q = c;
        else if (c === "[" || c === "{") nesting++;
        else if (c === "]" || c === "}") nesting--;
        else if (c === "," && nesting === 0) { parts.push(inner.slice(start, i)); start = i + 1; }
        if (nesting < 0) throw new Error("Unbalanced flow value");
      }
      if (q || nesting) throw new Error("Unbalanced flow value");
      parts.push(inner.slice(start));
      if (parts.some(p => !p.trim())) throw new Error("Empty flow list item");
      return parts.map(p => scalar(p.trim(), depth + 1));
    }
    if (/^[|>&*!%@\x60]/.test(v) || /:\s/.test(v) || /[\[\]{}]/.test(v)) {
      throw new Error("Unsupported YAML scalar; quote it or use JSON: " + v);
    }
    if (v === "true") return true;
    if (v === "false") return false;
    if (v === "null" || v === "~") return null;
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v)) {
      const number = Number(v);
      if (!Number.isFinite(number)) throw new Error("Non-finite number");
      return number;
    }
    return v;
  }
  const isList = text => /^-(?:\s|$)/.test(text);
  function block(indent, depth = 0) {
    if (depth > MAX_DEPTH) throw new Error("Task nesting exceeds limit");
    const list = isList(tokens[cursor].text);
    const result = list ? [] : {};
    while (cursor < tokens.length && tokens[cursor].indent >= indent) {
      const token = tokens[cursor];
      if (token.indent !== indent || isList(token.text) !== list) {
        throw new Error("Unexpected indentation or collection type at line " + token.line);
      }
      cursor++;
      if (list) {
        const rest = token.text.slice(1).trim();
        if (/^[A-Za-z_][\w-]*:(?:\s|$)/.test(rest)) {
          tokens.splice(cursor, 0, { ...token, indent: indent + 2, text: rest });
          result.push(block(indent + 2, depth + 1));
        } else if (rest) {
          result.push(scalar(rest));
        } else {
          result.push(cursor < tokens.length && tokens[cursor].indent > indent
            ? block(tokens[cursor].indent, depth + 1) : null);
        }
      } else {
        const match = /^([A-Za-z_][\w-]*):(?:\s+(.*)|$)$/.exec(token.text);
        if (!match) throw new Error("Invalid or unsupported map entry at line " + token.line);
        const [, key, rawRest] = match;
        const rest = rawRest?.startsWith("#") ? "" : rawRest;
        if (FORBIDDEN_KEYS.has(key)) throw new Error("Unsafe key: " + key);
        if (Object.hasOwn(result, key)) throw new Error("Duplicate key: " + key);
        result[key] = rest ? scalar(rest) : cursor < tokens.length && tokens[cursor].indent > indent
          ? block(tokens[cursor].indent, depth + 1) : null;
      }
    }
    return result;
  }
  if (!tokens.length) return {};
  if (tokens[0].indent !== 0) throw new Error("Root must not be indented");
  const result = block(0);
  assertSafeTree(result);
  return result;
}

// JSON is valid YAML; its lossless serializer avoids a second parser dialect.
export function renderTaskYaml(taskObj) {
  assertSafeTree(taskObj);
  return JSON.stringify(taskObj, null, 2);
}
// ── Validation ───────────────────────────────────────────────────────────────

export function validateTaskContract(taskObj) {
  const errors = [];
  try { assertSafeTree(taskObj); } catch (error) { return [error.message]; }
  if (!taskObj || typeof taskObj !== "object" || Array.isArray(taskObj)) {
    errors.push("Task contract root must be an object");
    return errors;
  }

  if (!taskObj.goal || typeof taskObj.goal !== "string" || !taskObj.goal.trim()) {
    errors.push("Missing or empty required field 'goal'");
  }

  if (taskObj.criteria !== undefined) {
    if (!Array.isArray(taskObj.criteria)) {
      errors.push("'criteria' must be an array");
    } else {
      taskObj.criteria.forEach((crit, idx) => {
        if (!crit || typeof crit !== "object" || Array.isArray(crit)) {
          errors.push(`criteria[${idx}] must be an object`);
          return;
        }
        if (typeof crit.id !== "string" || !/^[a-z][a-z0-9_]*$/.test(crit.id)) {
          errors.push(`criteria[${idx}].id is missing or invalid`);
        }
        if (typeof crit.description !== "string" || !crit.description.trim()) {
          errors.push(`criteria[${idx}].description is missing or invalid`);
        }
      });
    }
  }

  if (Array.isArray(taskObj.criteria)) {
    const ids = taskObj.criteria.map(c => c?.id);
    if (new Set(ids).size !== ids.length) errors.push("Duplicate criterion id");
  }
  for (const key of ["files_to_modify", "anti_goals", "constraints", "invariants", "edge_cases"]) {
    if (taskObj[key] !== undefined && (!Array.isArray(taskObj[key]) || taskObj[key].some(v => typeof v !== "string" || !v.trim()))) {
      errors.push(key + " must contain nonempty strings");
    }
  }
  if (taskObj.steps !== undefined && (!Array.isArray(taskObj.steps) || taskObj.steps.some(s =>
    !s || typeof s !== "object" || Array.isArray(s) || typeof s.description !== "string" || !s.description.trim() ||
    (s.status !== undefined && !["pending", "in_progress", "done", "blocked"].includes(s.status))))) {
    errors.push("steps must contain objects with descriptions and valid statuses");
  }

  if (taskObj.files_to_modify !== undefined && !Array.isArray(taskObj.files_to_modify)) {
    errors.push("'files_to_modify' must be an array of file paths");
  }

  if (taskObj.anti_goals !== undefined && !Array.isArray(taskObj.anti_goals)) {
    errors.push("'anti_goals' must be an array of strings");
  }

  return errors;
}

// ── Adapters & Projections ───────────────────────────────────────────────────

export function taskToPlanContract(taskObj) {
  const errors = validateTaskContract(taskObj);
  if (errors.length) throw new Error(errors.join("; "));
  const goal = taskObj.goal || "Task Goal";
  const expectedBehavior = taskObj.expected_behavior || taskObj.job_to_be_done || goal;

  const filesToModify = Array.isArray(taskObj.files_to_modify)
    ? taskObj.files_to_modify
    : [];

  const rawSteps = Array.isArray(taskObj.steps) ? taskObj.steps : [];
  const steps = rawSteps.length > 0
    ? rawSteps.map((s, idx) => ({
        id: s.id || `step_${idx + 1}`,
        description: s.description || `Execute step ${idx + 1}`,
        status: s.status || "pending",
      }))
    : [{ id: "step_1", description: goal, status: "pending" }];

  const rawCriteria = Array.isArray(taskObj.criteria) ? taskObj.criteria : [];
  const successCriteria = rawCriteria.map((c, idx) => ({
    id: c.id || `sc_${idx + 1}`,
    description: c.description || `Criterion ${idx + 1}`,
  }));

  const verificationStrategy = rawCriteria.map((c, idx) => {
    const critId = c.id || `sc_${idx + 1}`;
    return {
      criterion_id: critId,
      story_linkage: c.story || "UNLINKED",
      repo_context: c.repo_context || "core",
      required_proof_type: c.proof_type || "proof:unit_test",
      command: c.verify || "UNSPECIFIED",
      pass_means: c.pass_means || "UNSPECIFIED",
      what_remains_unverified: c.what_remains_unverified || "UNASSESSED",
    };
  });

  const upkeep = taskObj.semantic_upkeep_contract || {
    profile: "other",
    validation_bundle: "test_evidence",
    strictness_mode: "full",
  };

  return {
    goal,
    problem_statement: {
      expected_behavior: expectedBehavior,
      invariants: taskObj.invariants || [],
      edge_cases: taskObj.edge_cases || [],
    },
    files_to_modify: filesToModify,
    steps,
    semantic_upkeep_contract: upkeep,
    success_criteria: successCriteria,
    verification_strategy: verificationStrategy,
  };
}

export function taskToIntentContract(taskObj) {
  const errors = validateTaskContract(taskObj);
  if (errors.length) throw new Error(errors.join("; "));
  const goal = taskObj.goal || "";
  const jtbd = taskObj.job_to_be_done || goal;
  const primaryUser = taskObj.primary_user || "developer";
  const antiGoals = Array.isArray(taskObj.anti_goals) ? taskObj.anti_goals : [];
  const constraints = Array.isArray(taskObj.constraints) ? taskObj.constraints : [];

  const desiredOutcomes = Array.isArray(taskObj.criteria)
    ? taskObj.criteria.map(c => c.description)
    : [];

  const rawDeliverables = Array.isArray(taskObj.deliverables) ? taskObj.deliverables : [];
  const deliverables = rawDeliverables.map((d, idx) => ({
    id: d.id || `del_${idx + 1}`,
    kind: d.kind || "document",
    name: d.name || d.id || `Deliverable ${idx + 1}`,
    required: d.required !== false,
    purpose: d.purpose || "",
    qualityBars: d.quality_bars || [],
    requiredSections: d.required_sections || [],
    requiredSignals: d.required_signals || [],
    antiGoals: d.anti_goals || [],
    evidenceMode: d.evidence_mode || "review",
  }));

  return {
    primaryUser,
    jobToBeDone: jtbd,
    desiredOutcomes,
    antiGoals,
    constraints,
    deliverables,
  };
}

// ── Directory Synchronizer ───────────────────────────────────────────────────

export function syncTaskToPlanDir(planDir, { write = false } = {}) {
  if (!existsSync(planDir)) return { ok: false, error: "Plan directory not found: " + planDir };
  const taskFiles = TASK_CONTRACT_FILENAMES.map(fn => join(planDir, fn)).filter(p => {
    try { lstatSync(p); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  });
  if (!taskFiles.length) return { ok: true, present: false, changed: false };
  if (taskFiles.length !== 1) return { ok: false, present: true, error: "Ambiguous task contract files" };
  const originals = new Map();
  const written = [];
  try {
    if (!lstatSync(taskFiles[0]).isFile() || lstatSync(taskFiles[0]).isSymbolicLink()) {
      throw new Error("Task contract must be a regular file");
    }
    const raw = readFileSync(taskFiles[0], "utf8");
    const taskObj = parseYamlSimple(raw);
    const errors = validateTaskContract(taskObj);
    if (errors.length) return { ok: false, present: true, errors };
    const planObj = taskToPlanContract(taskObj);
    const intentObj = taskToIntentContract(taskObj);
    const planJson = JSON.stringify(planObj, null, 2);
    parsePlanJson(planJson);
    const outputs = new Map([
      [join(planDir, "plan.json"), planJson],
      [join(planDir, "intent_contract.json"), JSON.stringify(intentObj, null, 2)],
      [join(planDir, "plan.md"), projectPlanJsonToMd(planObj)],
    ]);
    for (const path of outputs.keys()) {
      let original = null;
      try {
        const st = lstatSync(path);
        if (!st.isFile() || st.isSymbolicLink()) throw new Error("Projection must be a regular file: " + path);
        original = readFileSync(path, "utf8");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      originals.set(path, original);
    }
    const drift = [...outputs].filter(([p, contents]) => originals.get(p) !== contents).map(([p]) => p);
    if (!write && drift.length) {
      return { ok: false, present: true, drift, error: "Task projections differ; explicit synchronization required", taskObj, planObj, intentObj };
    }
    // Prepare and validate everything before touching a projection. This is not
    // a crash-atomic multi-file transaction; concurrent writers are unsupported.
    if (write) {
      if (readFileSync(taskFiles[0], "utf8") !== raw) throw new Error("Task changed during synchronization");
      for (const path of drift) {
        written.push(path);
        writeFileSync(path, outputs.get(path));
      }
    }
    return { ok: true, present: true, changed: written.length > 0, taskObj, planObj, intentObj };
  } catch (error) {
    const rollbackErrors = [];
    for (const path of written.reverse()) {
      try {
        if (originals.get(path) === null) unlinkSync(path);
        else writeFileSync(path, originals.get(path));
      } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
    }
    return { ok: false, present: true, error: error.message, rollbackErrors };
  }
}
