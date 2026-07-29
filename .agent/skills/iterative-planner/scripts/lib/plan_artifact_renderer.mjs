import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import {
  escapeMdTableCell,
  normalizePlanText,
  parsePlanJson,
  projectPlanJsonToMd,
} from "./plan_contract.mjs";
import {
  findingsLedgerHasRenderableContent,
  renderFindingsMarkdownFromLedger,
} from "./plan_utils.mjs";

const ALL_ARTIFACTS = Object.freeze([
  "state.md",
  "findings.md",
  "plan.md",
  "verification.md",
  "persona_guidance.md",
  "persona_constraints.md",
  "persona_findings.md",
  "persona_execution.md",
]);

const STATUS_RENDERED = "rendered";
const STATUS_SOURCE_MISSING = "source_missing";
const STATUS_NOT_RENDERABLE = "not_renderable";
const STATUS_ERROR = "error";

function hashText(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function normalizeMirrorText(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\n+$/, "\n");
}

function readTextIfPresent(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  } catch {
    return null;
  }
}

function readJsonSource(path) {
  if (!existsSync(path)) {
    return { present: false, raw: null, parsed: null, error: null };
  }
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    return { present: true, raw: null, parsed: null, error: error.message };
  }
  try {
    return { present: true, raw, parsed: JSON.parse(raw), error: null };
  } catch (error) {
    return { present: true, raw, parsed: null, error: error.message };
  }
}

function compactTimestamp(value) {
  return typeof value === "string" && value.trim()
    ? value.replace(/\.\d{3}Z$/, "Z")
    : "?";
}

export function formatStateTransitionLine(transition) {
  const from = transition?.from || "?";
  const to = transition?.to || "?";
  const ts = compactTimestamp(transition?.timestamp);
  const metadata = [];
  if (transition?.gate_result) metadata.push(transition.gate_result);
  if (Array.isArray(transition?.failure_codes) && transition.failure_codes.length > 0) {
    metadata.push(`codes: ${transition.failure_codes.join(", ")}`);
  }
  if (transition?.is_forced) metadata.push("FORCED");
  return `${from} \u2192 ${to} (${ts}${metadata.length > 0 ? `, ${metadata.join("; ")}` : ""})`;
}

export function renderStateMarkdownFromJson(stateJson) {
  if (!stateJson || typeof stateJson !== "object" || Array.isArray(stateJson)) return null;

  const fixAttempts = stateJson.fix_attempts;
  const fixAttemptLines = typeof fixAttempts === "number"
    ? [fixAttempts > 0 ? `- ${fixAttempts} total` : "- (none yet)"]
    : Object.entries(fixAttempts || {}).length > 0
      ? Object.entries(fixAttempts).map(([step, count]) => `- ${step}: ${count}`)
      : ["- (none yet)"];

  const changeManifestLines = Array.isArray(stateJson.change_manifest) && stateJson.change_manifest.length > 0
    ? stateJson.change_manifest.map((entry) => `- ${typeof entry === "string" ? entry : JSON.stringify(entry)}`)
    : ["- (no changes yet)"];

  const transitions = Array.isArray(stateJson.transitions) ? stateJson.transitions : [];
  const lastTransition = transitions.length > 0
    ? formatStateTransitionLine(transitions[transitions.length - 1])
    : "INIT \u2192 EXPLORE (?)";
  const historyLines = transitions.length > 0
    ? transitions.map((transition) => `- ${formatStateTransitionLine(transition)}`)
    : ["- (no transitions recorded)"];

  return `# Current State: ${stateJson.state || "UNKNOWN"}
## Iteration: ${stateJson.iteration ?? "?"}
## Current Plan Step: ${stateJson.current_step || "N/A"}
## Pre-Step Checklist (reset before each EXECUTE step)
- [ ] Re-read state.md (this file)
- [ ] Re-read plan.md
- [ ] Re-read progress.md
- [ ] Re-read decisions.md (if fix attempt)
- [ ] Checkpoint created (if risky step or irreversible op)
## Fix Attempts (resets per plan step)
${fixAttemptLines.join("\n")}
## Change Manifest (current iteration)
${changeManifestLines.join("\n")}
## Last Transition: ${lastTransition}
## Transition History:
${historyLines.join("\n")}
`;
}

function renderVerificationMarkdownFromLedger(ledger) {
  const evidence = Array.isArray(ledger?.evidence) ? ledger.evidence : [];
  const waivers = Array.isArray(ledger?.waivers) ? ledger.waivers : [];
  if (evidence.length === 0 && waivers.length === 0) return null;

  const lines = [
    "# Verification",
    "*Generated from verification_ledger.json.*",
    "",
  ];

  if (evidence.length > 0) {
    lines.push("## Evidence");
    lines.push("| ID | Subject | Mode | Status | Command | Artifacts |");
    lines.push("|---|---|---|---|---|---|");
    for (const item of evidence) {
      lines.push(`| ${escapeMdTableCell(item?.id || "")} | ${escapeMdTableCell(item?.subject || "")} | ${escapeMdTableCell(item?.mode || "")} | ${escapeMdTableCell(item?.status || "")} | ${escapeMdTableCell(item?.command || "")} | ${escapeMdTableCell((item?.artifacts || []).join(", "))} |`);
    }
    lines.push("");
  }

  if (waivers.length > 0) {
    lines.push("## Waivers");
    lines.push("| ID | Subject | Mode | Reason | Approved by |");
    lines.push("|---|---|---|---|---|");
    for (const item of waivers) {
      lines.push(`| ${escapeMdTableCell(item?.id || "")} | ${escapeMdTableCell(item?.subject || "")} | ${escapeMdTableCell(item?.mode || "")} | ${escapeMdTableCell(item?.reason || "")} | ${escapeMdTableCell(item?.approved_by || "")} |`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

function renderPersonaGuidance(json) {
  const items = Array.isArray(json?.items) ? json.items : [];
  if (items.length === 0) return null;
  const phase = json?.phase ? ` for ${String(json.phase).toUpperCase()} Phase` : "";
  const lines = [`# Persona Guidance${phase}`, "", "| Pack | Guidance |", "|---|---|"];
  for (const item of items) {
    lines.push(`| ${escapeMdTableCell(item?.pack_id || "")} | ${escapeMdTableCell(item?.guidance || "")} |`);
  }
  return `${lines.join("\n").trim()}\n`;
}

function renderPersonaConstraints(json) {
  const constraints = Array.isArray(json?.constraints) ? json.constraints : [];
  if (constraints.length === 0) return null;
  const phase = json?.phase ? ` for ${String(json.phase).toUpperCase()} Phase` : "";
  const lines = [`# Persona Constraints${phase}`, "", "| ID | Severity | Constraint | Rationale | Stories |", "|---|---|---|---|---|"];
  for (const item of constraints) {
    lines.push(`| ${escapeMdTableCell(item?.id || "")} | ${escapeMdTableCell(item?.severity || "")} | ${escapeMdTableCell(item?.constraint || "")} | ${escapeMdTableCell(item?.rationale || "")} | ${escapeMdTableCell((item?.story_refs || []).join(", "))} |`);
  }
  return `${lines.join("\n").trim()}\n`;
}

function renderPersonaFindings(json) {
  const findings = Array.isArray(json?.findings) ? json.findings : [];
  if (findings.length === 0) return null;
  const gate = json?.gate ? ` for ${String(json.gate)}` : "";
  const lines = [`# Persona Findings${gate}`, "", "| Analyzer | Severity | Message | Location | Details |", "|---|---|---|---|---|"];
  for (const item of findings) {
    lines.push(`| ${escapeMdTableCell(item?.analyzer || "")} | ${escapeMdTableCell(item?.severity || "")} | ${escapeMdTableCell(item?.message || "")} | ${escapeMdTableCell(item?.location || "")} | ${escapeMdTableCell(item?.details || "")} |`);
  }
  return `${lines.join("\n").trim()}\n`;
}

function renderPersonaExecution(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const obligations = Array.isArray(json?.obligations) ? json.obligations : [];
  const decisions = Array.isArray(json?.persona_authority?.decisions) ? json.persona_authority.decisions : [];
  if (obligations.length === 0 && decisions.length === 0 && !json?.summary) return null;

  const lines = ["# Persona Execution", ""];
  if (json?.status || json?.phase) {
    lines.push(`- Status: ${json?.status || "unknown"}`);
    lines.push(`- Phase: ${json?.phase || "unknown"}`);
    lines.push("");
  }
  if (json?.summary) {
    lines.push("## Summary");
    for (const [key, value] of Object.entries(json.summary)) {
      lines.push(`- ${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
    }
    lines.push("");
  }
  if (decisions.length > 0) {
    lines.push("## Authority Decisions");
    lines.push("| Pack | Authority | Reason |");
    lines.push("|---|---|---|");
    for (const item of decisions) {
      lines.push(`| ${escapeMdTableCell(item?.pack_id || "")} | ${escapeMdTableCell(item?.authority || "")} | ${escapeMdTableCell(item?.reason || "")} |`);
    }
    lines.push("");
  }
  if (obligations.length > 0) {
    lines.push("## Obligations");
    lines.push("| ID | Severity | Status | Description |");
    lines.push("|---|---|---|---|");
    for (const item of obligations) {
      lines.push(`| ${escapeMdTableCell(item?.id || "")} | ${escapeMdTableCell(item?.severity || "")} | ${escapeMdTableCell(item?.status || "")} | ${escapeMdTableCell(item?.description || item?.summary || item?.label || "")} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

const ARTIFACT_RENDERERS = Object.freeze({
  "state.md": {
    source: "state.json",
    render: (json) => renderStateMarkdownFromJson(json),
  },
  "findings.md": {
    source: "findings_ledger.json",
    render: (json) => findingsLedgerHasRenderableContent(json) ? renderFindingsMarkdownFromLedger(json) : null,
  },
  "plan.md": {
    source: "plan.json",
    render: (_json, raw) => projectPlanJsonToMd(parsePlanJson(raw)),
  },
  "verification.md": {
    source: "verification_ledger.json",
    render: renderVerificationMarkdownFromLedger,
  },
  "persona_guidance.md": {
    source: "persona_guidance.json",
    render: renderPersonaGuidance,
  },
  "persona_constraints.md": {
    source: "persona_constraints.json",
    render: renderPersonaConstraints,
  },
  "persona_findings.md": {
    source: "persona_findings.json",
    render: renderPersonaFindings,
  },
  "persona_execution.md": {
    source: "persona_execution.json",
    render: renderPersonaExecution,
  },
});

export function listPlanArtifactTargets() {
  return [...ALL_ARTIFACTS];
}

export function normalizeArtifactSelection(selection = ["all"]) {
  const values = Array.isArray(selection) ? selection : [selection];
  const expanded = values
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (expanded.length === 0 || expanded.includes("all")) return listPlanArtifactTargets();
  return [...new Set(expanded)];
}

function baseResult({ planDir, artifact, spec }) {
  return {
    artifact,
    source: spec?.source || null,
    source_path: spec?.source ? join(planDir, spec.source) : null,
    target_path: join(planDir, artifact),
  };
}

function withExistingMirror(result, text = null) {
  const existing = readTextIfPresent(result.target_path);
  const existingNorm = existing === null ? null : normalizeMirrorText(existing);
  const renderedNorm = text === null ? null : normalizeMirrorText(text);
  return {
    ...result,
    existing_mirror: {
      present: existing !== null,
      bytes: existing === null ? 0 : Buffer.byteLength(existing, "utf-8"),
      hash: existing === null ? null : hashText(existingNorm),
      matches: existing === null || renderedNorm === null ? null : existingNorm === renderedNorm,
    },
  };
}

export function renderPlanArtifact(planDir, artifact) {
  const resolvedPlanDir = resolve(planDir);
  const normalizedArtifact = String(artifact || "").trim();
  const spec = ARTIFACT_RENDERERS[normalizedArtifact];
  if (!spec) {
    return withExistingMirror({
      artifact: normalizedArtifact,
      source: null,
      source_path: null,
      target_path: join(resolvedPlanDir, normalizedArtifact),
      status: STATUS_ERROR,
      error: `Unknown artifact '${normalizedArtifact}'`,
    });
  }

  const result = baseResult({ planDir: resolvedPlanDir, artifact: normalizedArtifact, spec });
  const source = readJsonSource(result.source_path);
  if (!source.present) {
    return withExistingMirror({
      ...result,
      status: STATUS_SOURCE_MISSING,
      source_hash: null,
      error: null,
    });
  }
  if (source.error) {
    return withExistingMirror({
      ...result,
      status: STATUS_ERROR,
      source_hash: source.raw === null ? null : hashText(source.raw),
      error: source.error,
    });
  }

  let text;
  try {
    text = spec.render(source.parsed, source.raw, resolvedPlanDir);
  } catch (error) {
    return withExistingMirror({
      ...result,
      status: STATUS_ERROR,
      source_hash: hashText(source.raw),
      error: error.message,
    });
  }

  if (typeof text !== "string" || !text.trim()) {
    return withExistingMirror({
      ...result,
      status: STATUS_NOT_RENDERABLE,
      source_hash: hashText(source.raw),
      error: null,
    });
  }

  const normalizedText = normalizePlanText(text);
  return withExistingMirror({
    ...result,
    status: STATUS_RENDERED,
    source_hash: hashText(source.raw),
    text: normalizedText,
    text_hash: hashText(normalizedText),
    text_bytes: Buffer.byteLength(normalizedText, "utf-8"),
    error: null,
  }, normalizedText);
}

export function renderPlanArtifacts(planDir, { artifacts = ["all"] } = {}) {
  return normalizeArtifactSelection(artifacts).map((artifact) => renderPlanArtifact(planDir, artifact));
}

export function writeRenderedArtifacts(planDir, { artifacts = ["all"] } = {}) {
  const results = renderPlanArtifacts(planDir, { artifacts });
  for (const result of results) {
    if (result.status !== STATUS_RENDERED) continue;
    writeFileSync(result.target_path, result.text);
    result.written = true;
  }
  return results;
}

function countFilesRecursive(root) {
  let count = 0;
  function visit(dir) {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        count += 1;
      }
    }
  }
  visit(root);
  return count;
}

function listSamplePlanDirs(plansDir, sampleLimit) {
  const limit = Number.isFinite(Number(sampleLimit)) && Number(sampleLimit) > 0
    ? Number(sampleLimit)
    : 5;
  return readdirSync(plansDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^plan_/.test(entry.name))
    .map((entry) => {
      const path = join(plansDir, entry.name);
      let mtimeMs = 0;
      try { mtimeMs = statSync(path).mtimeMs; } catch { /* best effort */ }
      return { name: entry.name, path, mtimeMs };
    })
    .sort((a, b) => (b.mtimeMs - a.mtimeMs) || b.name.localeCompare(a.name))
    .slice(0, limit);
}

export function measurePlanArtifactProjection({ plansDir = "plans", sampleLimit = 5 } = {}) {
  const resolvedPlansDir = resolve(plansDir);
  const plans = listSamplePlanDirs(resolvedPlansDir, sampleLimit).map((plan) => {
    const currentFileCount = countFilesRecursive(plan.path);
    const artifacts = renderPlanArtifacts(plan.path);
    const renderableExisting = artifacts.filter((item) =>
      item.status === STATUS_RENDERED && item.existing_mirror?.present
    );
    const projectedFileCount = currentFileCount - renderableExisting.length;
    return {
      plan: plan.name,
      plan_dir: plan.path,
      current_file_count: currentFileCount,
      renderable_existing_mirror_count: renderableExisting.length,
      projected_file_count: projectedFileCount,
      delta_files: projectedFileCount - currentFileCount,
      renderable_existing_mirrors: renderableExisting.map((item) => ({
        artifact: item.artifact,
        source: item.source,
        mirror_matches: item.existing_mirror?.matches,
      })),
      artifact_status_counts: artifacts.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      }, {}),
    };
  });

  const totalCurrent = plans.reduce((sum, plan) => sum + plan.current_file_count, 0);
  const totalProjected = plans.reduce((sum, plan) => sum + plan.projected_file_count, 0);
  return {
    status: "PASS",
    plans_dir: resolvedPlansDir,
    sample_count: plans.length,
    sampled_plans: plans.map((plan) => plan.plan),
    totals: {
      current_file_count: totalCurrent,
      projected_file_count: totalProjected,
      delta_files: totalProjected - totalCurrent,
      renderable_existing_mirror_count: plans.reduce((sum, plan) => sum + plan.renderable_existing_mirror_count, 0),
    },
    plans,
    migration_path: [
      "Keep JSON sources authoritative.",
      "Use render --write only to materialize mirrors explicitly.",
      "Only a later deletion ticket may remove mirrors, and only for rendered artifacts whose existing mirror matches the JSON projection.",
      "Preserve legacy markdown fallback until gate-survival evidence covers deletion.",
    ],
  };
}

export function resolvePlanDirForRenderer(planArg, { cwd = process.cwd() } = {}) {
  const raw = String(planArg || "").trim();
  if (!raw) return null;
  if (raw.includes("/") || raw.startsWith(".")) return resolve(cwd, raw);
  return resolve(cwd, "plans", raw);
}

export function summarizeRenderResults(planDir, results) {
  const counts = results.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  return {
    status: results.every((item) => item.status !== STATUS_ERROR) ? "PASS" : "FAIL",
    plan: basename(resolve(planDir)),
    plan_dir: resolve(planDir),
    counts,
    artifacts: results,
  };
}
