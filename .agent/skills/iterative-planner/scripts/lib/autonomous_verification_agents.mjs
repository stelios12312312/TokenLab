import { existsSync, readFileSync, statSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { sanitizeEnumAtom, sanitizeStrictId } from "./sanitize.mjs";

export const AVA_DEFECTS_FILE = "ava_defects.json";
export const AVA_ADVERSARIAL_PERSONA = "ava:adversarial";

const ACTIVE_STATUSES = new Set(["active", "open", "blocked", "fail", "failing"]);
const RESOLVED_STATUSES = new Set(["resolved", "closed", "fixed", "pass", "passed"]);

function readJson(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf-8")) };
  } catch (error) {
    return { ok: false, error };
  }
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeId(value, fallback) {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function normalizeStatus(value) {
  const normalized = String(value || "active").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (ACTIVE_STATUSES.has(normalized)) return "active";
  if (RESOLVED_STATUSES.has(normalized)) return "resolved";
  return normalized || "active";
}

function normalizePersona(value) {
  if (value && typeof value === "object") {
    return String(value.id || value.persona || value.name || "").trim();
  }
  return String(value || "").trim();
}

function personaAtom(persona) {
  return persona === AVA_ADVERSARIAL_PERSONA ? "adversarial" : persona.replace(/^ava:/, "");
}

function normalizeSandbox(sandbox = {}) {
  const timeBudgetMs = Number(sandbox.time_budget_ms ?? sandbox.max_duration_ms ?? sandbox.timeout_ms);
  const actionBudget = Number(sandbox.action_budget ?? sandbox.max_actions);
  const commandBudget = sandbox.command_budget === undefined ? null : Number(sandbox.command_budget);
  const database = String(sandbox.database || sandbox.db || "").trim().toLowerCase();
  const network = String(sandbox.network || "").trim().toLowerCase();
  const databaseOk = database === "in_memory";
  const networkOk = network === "interdicted";
  const timeOk = Number.isFinite(timeBudgetMs) && timeBudgetMs > 0;
  const actionOk = Number.isFinite(actionBudget) && actionBudget > 0;
  const commandOk = commandBudget === null || (Number.isFinite(commandBudget) && commandBudget > 0);
  return {
    database,
    network,
    time_budget_ms: timeBudgetMs,
    action_budget: actionBudget,
    command_budget: commandBudget,
    floor_satisfied: databaseOk && networkOk && timeOk && actionOk && commandOk,
    missing: [
      databaseOk ? null : "database=in_memory",
      networkOk ? null : "network=interdicted",
      timeOk ? null : "time_budget_ms>0",
      actionOk ? null : "action_budget>0",
      commandOk ? null : "command_budget>0",
    ].filter(Boolean),
  };
}

function anchorPath(ref) {
  const raw = String(ref || "").trim();
  if (!raw) return "";
  const withoutHash = raw.split("#")[0];
  const lineMatch = withoutHash.match(/^(.+?):\d+$/);
  return lineMatch ? lineMatch[1] : withoutHash;
}

function resolveAnchor(repoRoot, ref) {
  const pathPart = anchorPath(ref);
  if (!pathPart) return { ref: String(ref || ""), path: "", exists: false };
  const absolutePath = isAbsolute(pathPart) ? pathPart : resolve(repoRoot, pathPart);
  let exists = false;
  try {
    exists = existsSync(absolutePath) && statSync(absolutePath).isFile();
  } catch {
    exists = false;
  }
  return { ref: String(ref || ""), path: pathPart, absolute_path: absolutePath, exists };
}

function normalizeDefect(rawDefect, run, defectIndex, repoRoot) {
  const id = normalizeId(rawDefect.id || rawDefect.defect_id, `AVA-DEF-${defectIndex + 1}`);
  const status = normalizeStatus(rawDefect.status);
  const storyRefs = unique(asArray(rawDefect.story_refs || rawDefect.stories || rawDefect.linked_stories).map(String));
  const rawAnchors = unique(asArray(rawDefect.code_anchor_refs || rawDefect.code_anchors || rawDefect.anchors).map(String));
  const anchors = rawAnchors.map((ref) => resolveAnchor(repoRoot, ref));
  const physicalAnchors = anchors.filter((anchor) => anchor.exists);
  return {
    id,
    type: String(rawDefect.type || "prov:Defect").trim(),
    status,
    active: status === "active",
    summary: String(rawDefect.summary || rawDefect.message || id).trim(),
    story_refs: storyRefs,
    evidence_refs: unique(asArray(rawDefect.evidence_refs || rawDefect.evidence).map(String)),
    code_anchor_refs: rawAnchors,
    anchors,
    physical_anchors: physicalAnchors,
    discovered_by: run.id,
    replay: rawDefect.replay || null,
  };
}

function normalizeRun(rawRun, index, repoRoot) {
  const id = normalizeId(rawRun.id || rawRun.run_id, `AVA-RUN-${index + 1}`);
  const persona = normalizePersona(rawRun.persona || rawRun.persona_id || rawRun.agent || rawRun.agent_id);
  const sandbox = normalizeSandbox(rawRun.sandbox || rawRun.execution_floor || {});
  const defects = asArray(rawRun.defects || rawRun.discovered_defects).map((defect, defectIndex) =>
    normalizeDefect(defect || {}, { id }, defectIndex, repoRoot)
  );
  return {
    id,
    persona,
    persona_satisfied: persona === AVA_ADVERSARIAL_PERSONA,
    sandbox,
    defects,
  };
}

function loadRawArtifact(planDir) {
  const artifactPath = join(planDir, AVA_DEFECTS_FILE);
  if (!existsSync(artifactPath)) {
    return {
      present: false,
      path: artifactPath,
      errors: [],
      runs: [],
    };
  }
  const parsed = readJson(artifactPath);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    return {
      present: true,
      path: artifactPath,
      errors: [`invalid_ava_defects_json:${parsed.error?.message || "parse_error"}`],
      runs: [],
    };
  }
  return {
    present: true,
    path: artifactPath,
    errors: [],
    raw: parsed.value,
    runs: asArray(parsed.value.runs),
  };
}

export function loadAvaDefectReport({ planDir, repoRoot = process.cwd() } = {}) {
  if (!planDir) {
    return {
      present: false,
      errors: ["missing_plan_dir"],
      runs: [],
      defects: [],
    };
  }
  const artifact = loadRawArtifact(planDir);
  if (!artifact.present) return { ...artifact, defects: [] };
  const errors = [...artifact.errors];
  if (artifact.errors.length === 0 && artifact.runs.length === 0) {
    errors.push("ava_runs_missing");
  }
  const runs = artifact.runs.map((run, index) => normalizeRun(run || {}, index, repoRoot));
  const defects = runs.flatMap((run) => run.defects);
  return {
    present: true,
    path: artifact.path,
    errors,
    runs,
    defects,
  };
}

function blockingIssuesForReport(report) {
  if (!report.present) return [];
  const issues = [...report.errors];
  for (const run of report.runs) {
    if (!run.persona_satisfied) issues.push(`ava_persona_missing:${run.id}`);
    if (!run.sandbox.floor_satisfied) issues.push(`ava_sandbox_floor_missing:${run.id}`);
    for (const defect of run.defects) {
      if (!defect.active) continue;
      issues.push(`ava_active_defect:${defect.id}`);
      if (defect.physical_anchors.length === 0) issues.push(`ava_defect_missing_anchor:${defect.id}`);
    }
  }
  return unique(issues);
}

export function evaluateAvaGate({ planDir, repoRoot = process.cwd() } = {}) {
  const report = loadAvaDefectReport({ planDir, repoRoot });
  const blockingIssues = blockingIssuesForReport(report);
  return {
    ...report,
    required: report.present,
    satisfied: blockingIssues.length === 0,
    blocking_issues: blockingIssues,
    detail: !report.present
      ? "No AVA defect artifact present"
      : blockingIssues.length === 0
        ? `${report.defects.length} AVA defect(s) resolved or non-blocking`
        : `AVA close blockers: ${blockingIssues.join(", ")}`,
  };
}

export function compileAvaFacts({ planDir, repoRoot = process.cwd() } = {}) {
  const evaluation = evaluateAvaGate({ planDir, repoRoot });
  const facts = [`ava_report_present(${evaluation.present ? "true" : "false"}).`];
  if (!evaluation.present) return { ...evaluation, prolog: `${facts.join("\n")}\n` };
  for (const error of evaluation.errors || []) {
    facts.push(`ava_artifact_error(${sanitizeEnumAtom(error)}).`);
  }
  for (const run of evaluation.runs || []) {
    const runId = sanitizeStrictId(run.id);
    facts.push(`ava_verification_agent(${runId}).`);
    facts.push(`ava_agent_persona(${runId}, ${sanitizeEnumAtom(personaAtom(run.persona))}).`);
    facts.push(`ava_sandbox_floor_satisfied(${runId}, ${run.sandbox.floor_satisfied ? "true" : "false"}).`);
    for (const defect of run.defects || []) {
      const defectId = sanitizeStrictId(defect.id);
      facts.push(`ava_discovered_defect(${defectId}).`);
      facts.push(`ava_defect_discovered_by(${defectId}, ${runId}).`);
      facts.push(`ava_defect_type(${defectId}, ${sanitizeEnumAtom(defect.type === "prov:Defect" ? "prov_defect" : defect.type)}).`);
      facts.push(`ava_defect_status(${defectId}, ${sanitizeEnumAtom(defect.status)}).`);
      for (const storyRef of defect.story_refs || []) {
        facts.push(`ava_defect_story(${defectId}, ${sanitizeStrictId(storyRef)}).`);
      }
      for (const anchor of defect.physical_anchors || []) {
        facts.push(`ava_defect_anchor(${defectId}, ${sanitizeStrictId(anchor.ref)}).`);
      }
    }
  }
  return { ...evaluation, prolog: `${facts.join("\n")}\n` };
}

function factStatusForDefect(defect) {
  if (defect.active) return "fail";
  return "pass";
}

export function buildAvaPayloadFacts(evaluation) {
  if (!evaluation?.present) return [];
  const facts = [];
  for (const run of evaluation.runs || []) {
    facts.push({
      id: `ava-agent:${run.id}`,
      type: "AutonomousVerificationAgent",
      status: run.persona_satisfied && run.sandbox.floor_satisfied ? "pass" : "fail",
      label: run.persona || AVA_ADVERSARIAL_PERSONA,
      detail: run.sandbox.floor_satisfied
        ? "sandbox floor: in-memory database, network interdicted, bounded time/actions"
        : `sandbox floor missing: ${run.sandbox.missing.join(", ") || "unknown"}`,
      route: ".agent/skills/iterative-planner/scripts/lib/autonomous_verification_agents.mjs",
    });
    for (const defect of run.defects || []) {
      const missingAnchor = defect.active && defect.physical_anchors.length === 0;
      facts.push({
        id: `ava-defect:${defect.id}`,
        type: "AvaDefect",
        status: missingAnchor || defect.active ? "fail" : factStatusForDefect(defect),
        label: missingAnchor ? "ava_defect_missing_anchor" : defect.active ? "ava_active_defect" : "ava_resolved_defect",
        detail: `${defect.id}: ${defect.summary}; stories=${defect.story_refs.join(", ") || "none"}; anchors=${defect.physical_anchors.map((anchor) => anchor.ref).join(", ") || "missing"}`,
        route: evaluation.path || AVA_DEFECTS_FILE,
      });
    }
  }
  return facts;
}

export function buildAvaPayloadViolations(evaluation) {
  if (!evaluation?.present) return [];
  return (evaluation.blocking_issues || []).map((issue) => {
    const [code, subject = "artifact"] = String(issue).split(":");
    return {
      id: code,
      severity: "fail",
      status: "blocked",
      message: `${code}: ${subject}`,
    };
  });
}
