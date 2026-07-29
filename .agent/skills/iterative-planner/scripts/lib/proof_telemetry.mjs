import {
  appendFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, extname, join, resolve, relative } from "path";

import { isFeatureEnabled, nowISO, readStateJson } from "./determinism.mjs";
import { extractFilesToModify } from "./plan_utils.mjs";
import { evaluateLeakageProofFile } from "../../packs/quant/leakage_proof.mjs";

const VALID_EVENTS = new Set([
  "surface_touched",
  "task_signal_detected",
  "proof_recorded",
  "artifact_created",
  "action_completed",
]);

const TRUSTED_LEVELS = new Set(["trusted", "verified_derived"]);
const ARTIFACT_BACKED_PROOFS = new Set(["manual_observation", "visual_proof", "renderer_contract_check"]);
const LEAKAGE_ARTIFACT_BACKED_PROOFS = new Set(["leakage_check", "temporal_split_check"]);

function safeRead(filePath) {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function canonicalRoot(root) {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

function safeReadJsonLines(filePath) {
  if (!existsSync(filePath)) return [];
  const lines = safeRead(filePath).split("\n").filter((line) => line.trim());
  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      parsed.push(null);
    }
  }
  return parsed;
}

function uniqueList(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function normalizePath(root, filePath) {
  const raw = String(filePath || "").trim();
  if (!raw) return null;
  let absolute = raw.startsWith("/") ? resolve(raw) : resolve(root, raw);
  try {
    absolute = realpathSync(absolute);
  } catch {
    // Fall back to the resolved path when the file does not exist yet.
  }
  const projectRelative = relative(root, absolute).replace(/\\/g, "/");
  if (projectRelative.startsWith("..")) return null;
  return projectRelative || basename(absolute);
}

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || null;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[`*_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractGoalFromPlanContent(planContent) {
  const match = String(planContent || "").match(/^## Goal\s*\n([\s\S]*?)(?=\n## |\n# |$)/m);
  return match ? match[1].trim().split("\n")[0].trim() : "";
}

function loadArchetype(cwd) {
  const policyPath = join(cwd, "planner.discovery.json");
  if (!existsSync(policyPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(policyPath, "utf-8"));
    const archetype = typeof parsed?.archetype === "string" ? normalizeToken(parsed.archetype) : null;
    return archetype || null;
  } catch {
    return null;
  }
}

function deriveSurfacesFromPath(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/").toLowerCase();
  if (!normalized) return [];

  const surfaces = [];
  const ext = extname(normalized);

  if (
    /\.(tsx|jsx|vue|svelte|html|css|scss|less)$/i.test(normalized) ||
    /(^|\/)(src|app|pages|components|review|ui|frontend|templates)\//.test(normalized)
  ) {
    surfaces.push("browser_ui");
  }

  if (
    /(^|\/)(api|routes|route|webhook|connector|client|integration|runner|jobs|pipelines?)\//.test(normalized) ||
    /(route|webhook|connector|integration|runner)\.(ts|js|mjs|py|rb|php)$/i.test(normalized)
  ) {
    surfaces.push("api_integration");
  }

  if (
    /(^|\/)(models?|signals?|factors?|alphas?|strategies?|portfolio|backtest|research|notebooks?)\//.test(normalized) ||
    /(signal|factor|alpha|strategy|backtest|portfolio|forecast|model)\.(py|ipynb|r|jl|mjs|ts)$/i.test(normalized)
  ) {
    surfaces.push("quant_modeling");
  }

  if (
    /(^|\/)(config|configs|settings|env)\//.test(normalized) ||
    /(^|\/)\.env(\.|$)/.test(normalized) ||
    /(config|settings|flags?)\.(json|ya?ml|toml|ini|env|ts|js)$/i.test(normalized)
  ) {
    surfaces.push("config_flags");
  }

  if (
    /(wizard|checkout|onboarding|approval|navigation|toast)[a-z0-9_-]*\.(tsx|jsx|ts|js|py|rb)$/i.test(normalized) ||
    /(^|\/)(wizard|checkout|onboarding|approval|navigation|journey|funnel)\//.test(normalized)
  ) {
    surfaces.push("stateful_user_flow");
  }

  if (
    normalized.includes(".agent/skills/iterative-planner/") ||
    normalized.startsWith(".agent/workflows/") ||
    normalized.startsWith("plans/knowledge/") ||
    normalized.startsWith("reports/user_story_audit/")
  ) {
    surfaces.push("planner_core_shared_surface");
  }

  if (ext === ".md" && normalized.startsWith("docs/")) {
    surfaces.push("docs_contract");
  }

  return uniqueList(surfaces);
}

function isPlannerOwnedEvidencePath(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  return normalized.startsWith(".agent/") ||
    normalized.startsWith("plans/") ||
    normalized.startsWith("reports/") ||
    normalized.startsWith("docs/");
}

function plannedHostSurfaceTouched(plannedFiles, surface) {
  return (plannedFiles || []).some((file) =>
    !isPlannerOwnedEvidencePath(file) && deriveSurfacesFromPath(file).includes(surface));
}

function inferProofTypesFromCommand(command) {
  const normalized = normalizeText(command);
  if (!normalized) return [];

  const proofs = [];

  if (/(^| )(npm|pnpm|yarn|bun) (test|run test|run check|run lint)( |$)|\b(pytest|vitest|jest|rspec|go test|cargo test)\b/.test(normalized)) {
    proofs.push("unit_test");
  }
  if (/\b(playwright|cypress|selenium|webdriver|browser e2e|browser journey)\b/.test(normalized)) {
    proofs.push("browser_journey");
  }
  if (/\b(--dry-run|dry run|preview)\b/.test(normalized)) {
    proofs.push("dry_run");
  }
  if (/\b(curl|httpie|wget)\b/.test(normalized)) {
    proofs.push("api_probe");
  }
  if (/\bsmoke\b/.test(normalized)) {
    proofs.push("integration_smoke");
  }
  if (/\btest_transition_gate_flows\.mjs\b|\btest_bootstrap_state_surface\.mjs\b|\bmigration-bootstrap\b|\btransition-gate-flows\b/.test(normalized)) {
    proofs.push("planner_smoke");
  }
  if (/\b(doc-contract-mvp|doc-contract-multi-ide|docs-contracts)\b/.test(normalized)) {
    proofs.push("doc_contract_check");
  }
  if (/\bripple_check\.mjs\b/.test(normalized)) {
    proofs.push("ripple_check");
  }
  if (/\bmigrate\.mjs (setup|verify|verify fleet|upgrade)\b/.test(normalized)) {
    proofs.push("migration_verification");
  }
  if (/\b(renderer_contract_check|renderer contract check)\b/.test(normalized)) {
    proofs.push("renderer_contract_check");
  }
  if (/\b(mutually_exclusive_check|mutually exclusive check)\b/.test(normalized)) {
    proofs.push("mutually_exclusive_check");
  }
  if (/\b(postcondition_check|postcondition check)\b/.test(normalized)) {
    proofs.push("postcondition_check");
  }
  if (/\bout of sample\b|\boos\b/.test(normalized)) {
    proofs.push("out_of_sample_validation");
  }
  if (/\bbenchmark\b/.test(normalized)) {
    proofs.push("benchmark_comparison");
  }
  if (/\bcalibration\b/.test(normalized)) {
    proofs.push("calibration_check");
  }
  if (/\bbacktest\b/.test(normalized)) {
    proofs.push("backtest_run");
  }
  if (/\blive parity\b|\bparity\b/.test(normalized)) {
    proofs.push("live_parity_check");
  }

  return uniqueList(proofs);
}

function deriveTaskSignals({ goalText, planContent, plannedFiles }) {
  const combined = [goalText, planContent, ...(plannedFiles || [])].filter(Boolean).join("\n");
  const normalized = normalizeText(combined);
  const signals = [];

  if (/\{\{\s*[a-z0-9_-]+\s*:/i.test(combined) || /\b(structural token|synthetic token|marker token|placeholder)\b/.test(normalized)) {
    signals.push("structural_token_output");
  }
  if (/\b(mutually exclusive|config flag|config flags|env var|environment variable|llm_mode|mock mode|contradictory runtime)\b/.test(normalized) ||
      plannedHostSurfaceTouched(plannedFiles, "config_flags")) {
    signals.push("config_flags_changed");
  }
  if (/\b(wizard|approval flow|after navigation|persist after navigation|success toast|postcondition|postconditions|stateful user flow|browser journey|multi-step)\b/.test(normalized) ||
      plannedHostSurfaceTouched(plannedFiles, "stateful_user_flow")) {
    signals.push("stateful_user_flow");
  }
  if (/\b(model|signal|factor|alpha|strategy|ranking model|feature engineering)\b/.test(normalized)) {
    signals.push("model_or_signal_change");
  }
  if (/\b(prediction|forecast|score|ranking output|report|prediction output)\b/.test(normalized)) {
    signals.push("prediction_output_change");
  }
  if (/\b(backtest|simulation|walk forward|live parity|paper trading|execution parity)\b/.test(normalized)) {
    signals.push("backtest_logic_change");
  }

  return uniqueList(signals);
}

function artifactExists(cwd, artifactPath) {
  const root = canonicalRoot(cwd);
  const normalized = normalizePath(root, artifactPath);
  if (!normalized) return false;
  return existsSync(join(root, normalized));
}

function proofArtifactAccepted(cwd, proofType, artifactPath) {
  if (LEAKAGE_ARTIFACT_BACKED_PROOFS.has(proofType)) {
    if (!artifactPath) return false;
    return evaluateLeakageProofFile(resolve(canonicalRoot(cwd), artifactPath)).pass === true;
  }
  if (ARTIFACT_BACKED_PROOFS.has(proofType)) {
    return artifactExists(cwd, artifactPath);
  }
  return true;
}

function dedupeKey(entry) {
  return [
    entry.event,
    entry.surface || "",
    entry.task_signal || "",
    entry.proof_type || "",
    entry.file || "",
    entry.command || "",
    entry.artifact_path || "",
  ].join("|");
}

export function getProofTelemetryPaths(planDir) {
  const telemetryDir = join(planDir, "telemetry");
  return {
    telemetryDir,
    eventsPath: join(telemetryDir, "events.jsonl"),
    summaryPath: join(telemetryDir, "summary.json"),
  };
}

export function recordProofTelemetryFromToolUse({
  cwd = process.cwd(),
  planDir,
  planDirName,
  phase = "UNKNOWN",
  toolName = "",
  toolInput = {},
  paths = [],
} = {}) {
  if (!isFeatureEnabled("proof_telemetry") || !planDir || !planDirName) {
    return { written: false, reason: "disabled_or_missing_plan" };
  }

  const { telemetryDir, eventsPath } = getProofTelemetryPaths(planDir);
  mkdirSync(telemetryDir, { recursive: true });

  const timestamp = nowISO();
  const repoRoot = canonicalRoot(cwd);
  const events = [];
  const normalizedPaths = uniqueList((paths || [])
    .map((filePath) => normalizePath(repoRoot, filePath))
    .filter(Boolean));

  for (const file of normalizedPaths) {
    for (const surface of deriveSurfacesFromPath(file)) {
      events.push({
        event: "surface_touched",
        timestamp,
        plan_id: planDirName,
        repo_root: repoRoot,
        phase,
        surface,
        file,
        source: "post_tool_use",
        trust_level: "trusted",
      });
    }

    if ((toolName === "Write" || toolName === "Edit") && /\.(png|jpe?g|gif|webp|svg|pdf|json|md)$/i.test(file)) {
      events.push({
        event: "artifact_created",
        timestamp,
        plan_id: planDirName,
        repo_root: repoRoot,
        phase,
        artifact_path: file,
        source: "post_tool_use",
        trust_level: "trusted",
      });
    }
  }

  const command = toolName === "Bash"
    ? String(toolInput.command || "")
      .replace(/[\x00-\x1f\x7f]/g, "")
      .replace(/[<>&"']/g, "_")
      .slice(0, 200)
    : "";

  if (command) {
    events.push({
      event: "action_completed",
      timestamp,
      plan_id: planDirName,
      repo_root: repoRoot,
      phase,
      command,
      source: "post_tool_use",
      trust_level: "trusted",
    });
    for (const proofType of inferProofTypesFromCommand(command)) {
      events.push({
        event: "proof_recorded",
        timestamp,
        plan_id: planDirName,
        repo_root: repoRoot,
        phase,
        proof_type: proofType,
        command,
        source: "post_tool_use",
        trust_level: "trusted",
      });
    }
  }

  if (events.length === 0) return { written: false, reason: "no_events" };

  for (const event of events) {
    appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
  }

  return { written: true, count: events.length, eventsPath };
}

export function summarizeProofTelemetry({
  cwd = process.cwd(),
  planDir = null,
  planDirName = null,
  goalText = "",
  planContent = "",
  plannedFiles = [],
  archetype = null,
  persist = true,
} = {}) {
  const enabled = isFeatureEnabled("proof_telemetry");
  if (!planDir || !planDirName) {
    return {
      enabled,
      mode: "unavailable",
      plan_id: planDirName || null,
      repo_root: canonicalRoot(cwd),
      archetype: normalizeToken(archetype),
      trusted_events_count: 0,
      ignored_event_count: 0,
      surfaces: [],
      proof_events: [],
      task_signals: [],
      artifacts: [],
    };
  }

  if (!enabled) {
    return {
      enabled: false,
      mode: "disabled",
      plan_id: planDirName,
      repo_root: canonicalRoot(cwd),
      archetype: normalizeToken(archetype),
      trusted_events_count: 0,
      ignored_event_count: 0,
      surfaces: [],
      proof_events: [],
      task_signals: [],
      artifacts: [],
    };
  }

  const { telemetryDir, eventsPath, summaryPath } = getProofTelemetryPaths(planDir);
  if (!existsSync(eventsPath)) {
    return {
      enabled: true,
      mode: "absent",
      plan_id: planDirName,
      repo_root: canonicalRoot(cwd),
      archetype: normalizeToken(archetype) || loadArchetype(cwd),
      trusted_events_count: 0,
      ignored_event_count: 0,
      surfaces: [],
      proof_events: [],
      task_signals: deriveTaskSignals({ goalText, planContent, plannedFiles }),
      artifacts: [],
    };
  }

  const resolvedRoot = canonicalRoot(cwd);
  const actualPlanContent = planContent || safeRead(join(planDir, "plan.md"));
  const actualGoal = goalText || (readStateJson(planDir)?.goal || extractGoalFromPlanContent(actualPlanContent));
  const actualPlannedFiles = uniqueList([
    ...(Array.isArray(plannedFiles) ? plannedFiles : []),
    ...extractFilesToModify(actualPlanContent),
  ]);

  const surfaces = new Set();
  const proofEvents = new Set();
  const taskSignals = new Set(deriveTaskSignals({
    goalText: actualGoal,
    planContent: actualPlanContent,
    plannedFiles: actualPlannedFiles,
  }));
  const artifacts = new Set();
  const seen = new Set();
  let trustedEventsCount = 0;
  let ignoredEventCount = 0;

  for (const rawEntry of safeReadJsonLines(eventsPath)) {
    if (!rawEntry || typeof rawEntry !== "object") {
      ignoredEventCount++;
      continue;
    }

    const eventType = normalizeToken(rawEntry.event);
    const trustLevel = normalizeToken(rawEntry.trust_level) || "trusted";
    if (!VALID_EVENTS.has(eventType) || !TRUSTED_LEVELS.has(trustLevel)) {
      ignoredEventCount++;
      continue;
    }

    if (rawEntry.plan_id && String(rawEntry.plan_id).trim() !== planDirName) {
      ignoredEventCount++;
      continue;
    }

    const repoRoot = rawEntry.repo_root ? canonicalRoot(String(rawEntry.repo_root)) : resolvedRoot;
    if (repoRoot !== resolvedRoot) {
      ignoredEventCount++;
      continue;
    }

    const entry = {
      event: eventType,
      surface: normalizeToken(rawEntry.surface),
      task_signal: normalizeToken(rawEntry.task_signal),
      proof_type: normalizeToken(rawEntry.proof_type),
      file: normalizePath(resolvedRoot, rawEntry.file),
      command: rawEntry.command ? String(rawEntry.command).trim() : "",
      artifact_path: normalizePath(resolvedRoot, rawEntry.artifact_path),
    };

    const key = dedupeKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);

    if (entry.file) {
      for (const surface of deriveSurfacesFromPath(entry.file)) {
        surfaces.add(surface);
      }
    }
    if (entry.surface) surfaces.add(entry.surface);
    if (entry.task_signal) taskSignals.add(entry.task_signal);

    if (entry.artifact_path && artifactExists(cwd, entry.artifact_path)) {
      artifacts.add(entry.artifact_path);
    }

    if (entry.proof_type) {
      if (!proofArtifactAccepted(cwd, entry.proof_type, entry.artifact_path)) {
        ignoredEventCount++;
        continue;
      }
      proofEvents.add(entry.proof_type);
    }

    for (const inferred of inferProofTypesFromCommand(entry.command)) {
      proofEvents.add(inferred);
    }

    trustedEventsCount++;
  }

  const mode = trustedEventsCount > 0 ? (ignoredEventCount > 0 ? "partial" : "present") : "invalid";
  const summary = {
    generated_at: nowISO(),
    enabled: true,
    mode,
    plan_id: planDirName,
    repo_root: resolvedRoot,
    archetype: normalizeToken(archetype) || loadArchetype(cwd),
    trusted_events_count: trustedEventsCount,
    ignored_event_count: ignoredEventCount,
    surfaces: uniqueList([...surfaces]),
    proof_events: uniqueList([...proofEvents]),
    task_signals: uniqueList([...taskSignals]),
    artifacts: uniqueList([...artifacts]),
  };

  if (persist && trustedEventsCount > 0) {
    mkdirSync(telemetryDir, { recursive: true });
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  } else if (persist && existsSync(summaryPath) && trustedEventsCount === 0) {
    try {
      const stats = statSync(summaryPath);
      if (stats.isFile()) writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    } catch {
      // Best-effort only.
    }
  }

  return summary;
}
