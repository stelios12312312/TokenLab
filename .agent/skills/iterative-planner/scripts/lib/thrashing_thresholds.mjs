import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

export const THRASHING_THRESHOLDS_FILENAME = "thrashing_thresholds.yaml";
export const THRASHING_THRESHOLDS_RELATIVE_PATH = join(".agent", THRASHING_THRESHOLDS_FILENAME);
export const THRASHING_THRESHOLDS_SCHEMA_RELATIVE_PATH = join(
  ".agent",
  "skills",
  "iterative-planner",
  "config",
  "thrashing_thresholds.schema.json"
);

export const THRASHING_SIGNAL_ORDER = Object.freeze([
  "thrashing_repeat_edit",
  "thrashing_oscillating_errors",
  "thrashing_backtrack_pattern",
  "thrashing_checkpoint_flood",
  "thrashing_tool_call_volume",
  "thrashing_criterion_stuck",
  "thrashing_progress_divergence",
  "thrashing_silent_scope_creep",
  "thrashing_test_regression",
  "thrashing_no_artifact_progress",
  "thrashing_criterion_overbudget",
  "thrashing_session_overbudget",
  "thrashing_reflect_overdue",
  "thrashing_plan_not_reread",
]);

const VALID_SEVERITIES = new Set(["low", "medium", "high", "critical"]);

const SIGNAL_FIELD_SPECS = Object.freeze({
  thrashing_repeat_edit: {
    lookback_tool_calls: "integer",
    repeat_edit_count: "integer",
    require_progress_stall: "boolean",
  },
  thrashing_oscillating_errors: {
    lookback_tool_calls: "integer",
    repeat_error_count: "integer",
    normalize_whitespace: "boolean",
  },
  thrashing_backtrack_pattern: {
    lookback_tool_calls: "integer",
    distinct_edit_events: "integer",
    require_revert_after_edit: "boolean",
  },
  thrashing_checkpoint_flood: {
    checkpoint_commits_per_criterion: "integer",
  },
  thrashing_tool_call_volume: {
    historical_percentile: "percent",
    multiplier: "ratio",
  },
  thrashing_criterion_stuck: {
    duration_multiplier: "ratio",
    minimum_minutes: "integer",
  },
  thrashing_progress_divergence: {
    path_overlap_ratio: "fraction",
    minimum_unplanned_mentions: "integer",
  },
  thrashing_silent_scope_creep: {
    unplanned_file_count: "integer",
    allow_listed_generated_artifacts: "boolean",
  },
  thrashing_test_regression: {
    failing_runs: "integer",
    require_prior_pass: "boolean",
  },
  thrashing_no_artifact_progress: {
    stalled_tool_calls: "integer",
    require_active_criterion: "boolean",
  },
  thrashing_criterion_overbudget: {
    budget_multiplier: "ratio",
    minimum_minutes: "integer",
  },
  thrashing_session_overbudget: {
    budget_multiplier: "ratio",
    minimum_minutes: "integer",
  },
  thrashing_reflect_overdue: {
    tool_calls_without_reflect: "integer",
    ignore_if_recent_mini_reflect: "boolean",
  },
  thrashing_plan_not_reread: {
    tool_calls_since_plan_read: "integer",
    warn_before_block: "boolean",
  },
});

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseJsonCompatibleYaml(text) {
  try {
    const parsed = JSON.parse(String(text || ""));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizePathLabel(filePath, cwd) {
  const normalizedCwd = resolve(cwd || process.cwd());
  const normalizedPath = resolve(filePath);
  if (normalizedPath.startsWith(`${normalizedCwd}/`)) {
    return normalizedPath.slice(normalizedCwd.length + 1);
  }
  return normalizedPath;
}

function pushIssue(issues, pathLabel, message) {
  issues.push(`${pathLabel}: ${message}`);
}

function validateInteger(value, pathLabel, issues) {
  if (!Number.isInteger(value) || value < 1) {
    pushIssue(issues, pathLabel, "must be an integer >= 1");
  }
}

function validateRatio(value, pathLabel, issues) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 1) {
    pushIssue(issues, pathLabel, "must be a number > 1");
  }
}

function validateFraction(value, pathLabel, issues) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    pushIssue(issues, pathLabel, "must be a number between 0 and 1");
  }
}

function validatePercent(value, pathLabel, issues) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 50 || value > 100) {
    pushIssue(issues, pathLabel, "must be a number between 50 and 100");
  }
}

function validateBoolean(value, pathLabel, issues) {
  if (typeof value !== "boolean") {
    pushIssue(issues, pathLabel, "must be a boolean");
  }
}

function validateSignalConfig(signalId, config, issues, pathLabel) {
  if (!isPlainObject(config)) {
    pushIssue(issues, pathLabel, "must be an object");
    return;
  }

  if (typeof config.enabled !== "boolean") {
    pushIssue(issues, `${pathLabel}.enabled`, "must be a boolean");
  }
  if (!VALID_SEVERITIES.has(config.severity)) {
    pushIssue(issues, `${pathLabel}.severity`, `must be one of: ${[...VALID_SEVERITIES].join(", ")}`);
  }

  const spec = SIGNAL_FIELD_SPECS[signalId] || {};
  for (const [fieldName, kind] of Object.entries(spec)) {
    const value = config[fieldName];
    const fieldPath = `${pathLabel}.${fieldName}`;
    switch (kind) {
      case "integer":
        validateInteger(value, fieldPath, issues);
        break;
      case "ratio":
        validateRatio(value, fieldPath, issues);
        break;
      case "fraction":
        validateFraction(value, fieldPath, issues);
        break;
      case "percent":
        validatePercent(value, fieldPath, issues);
        break;
      case "boolean":
        validateBoolean(value, fieldPath, issues);
        break;
      default:
        break;
    }
  }

  const expectedKeys = new Set(["enabled", "severity", ...Object.keys(spec)]);
  for (const key of Object.keys(config)) {
    if (!expectedKeys.has(key)) {
      pushIssue(issues, `${pathLabel}.${key}`, "is not part of the canonical threshold contract");
    }
  }
}

function validateResponseProgression(responseProgression, issues, pathLabel) {
  if (!isPlainObject(responseProgression)) {
    pushIssue(issues, pathLabel, "must be an object");
    return;
  }

  const level1 = responseProgression.level_1_hint;
  if (!isPlainObject(level1)) {
    pushIssue(issues, `${pathLabel}.level_1_hint`, "must be an object");
  } else {
    validateInteger(level1.min_active_signals, `${pathLabel}.level_1_hint.min_active_signals`, issues);
    if (!VALID_SEVERITIES.has(level1.max_signal_severity)) {
      pushIssue(issues, `${pathLabel}.level_1_hint.max_signal_severity`, `must be one of: ${[...VALID_SEVERITIES].join(", ")}`);
    }
  }

  const level2 = responseProgression.level_2_mini_reflect;
  if (!isPlainObject(level2)) {
    pushIssue(issues, `${pathLabel}.level_2_mini_reflect`, "must be an object");
  } else {
    validateInteger(level2.min_active_signals, `${pathLabel}.level_2_mini_reflect.min_active_signals`, issues);
    if (!Array.isArray(level2.severe_signal_levels) || level2.severe_signal_levels.length === 0) {
      pushIssue(issues, `${pathLabel}.level_2_mini_reflect.severe_signal_levels`, "must be a non-empty array");
    } else {
      for (const entry of level2.severe_signal_levels) {
        if (!VALID_SEVERITIES.has(entry)) {
          pushIssue(issues, `${pathLabel}.level_2_mini_reflect.severe_signal_levels`, `contains unsupported severity '${entry}'`);
        }
      }
    }
  }

  const level3 = responseProgression.level_3_hard_block;
  if (!isPlainObject(level3)) {
    pushIssue(issues, `${pathLabel}.level_3_hard_block`, "must be an object");
  } else {
    validateInteger(level3.retrigger_within_tool_calls, `${pathLabel}.level_3_hard_block.retrigger_within_tool_calls`, issues);
    validateInteger(level3.continue_decisions_before_block, `${pathLabel}.level_3_hard_block.continue_decisions_before_block`, issues);
  }

  const expectedKeys = new Set(["level_1_hint", "level_2_mini_reflect", "level_3_hard_block"]);
  for (const key of Object.keys(responseProgression)) {
    if (!expectedKeys.has(key)) {
      pushIssue(issues, `${pathLabel}.${key}`, "is not part of the canonical response progression contract");
    }
  }
}

function resolveThresholdsPath(cwd, explicitPath) {
  if (explicitPath) {
    return resolve(cwd, explicitPath);
  }
  return join(resolve(cwd), THRASHING_THRESHOLDS_RELATIVE_PATH);
}

export function readThrashingThresholdsDocument({ cwd = process.cwd(), path = null } = {}) {
  const resolvedPath = resolveThresholdsPath(cwd, path);
  if (!existsSync(resolvedPath)) {
    return {
      ok: false,
      path: resolvedPath,
      present: false,
      document: null,
      thresholds: null,
      errors: [`Missing ${THRASHING_THRESHOLDS_RELATIVE_PATH}`],
    };
  }

  let raw = null;
  try {
    raw = readFileSync(resolvedPath, "utf-8");
  } catch (error) {
    return {
      ok: false,
      path: resolvedPath,
      present: true,
      document: null,
      thresholds: null,
      errors: [`Unable to read ${THRASHING_THRESHOLDS_RELATIVE_PATH}: ${error.message}`],
    };
  }

  const document = parseJsonCompatibleYaml(raw);
  if (!document) {
    return {
      ok: false,
      path: resolvedPath,
      present: true,
      document: null,
      thresholds: null,
      errors: [`${THRASHING_THRESHOLDS_FILENAME} must be valid JSON-compatible YAML`],
    };
  }

  return {
    ok: true,
    path: resolvedPath,
    present: true,
    document,
    thresholds: document?.thrashing_thresholds || null,
    errors: [],
  };
}

export function validateThrashingThresholdsDocument(document, { cwd = process.cwd(), path = THRASHING_THRESHOLDS_RELATIVE_PATH } = {}) {
  const issues = [];
  const pathLabel = normalizePathLabel(path, cwd);

  if (!isPlainObject(document)) {
    return {
      ok: false,
      thresholds: null,
      issues: [`${pathLabel}: root document must be an object`],
    };
  }

  const thresholds = document.thrashing_thresholds;
  if (!isPlainObject(thresholds)) {
    return {
      ok: false,
      thresholds: null,
      issues: [`${pathLabel}: missing thrashing_thresholds root object`],
    };
  }

  if (thresholds.version !== 1) {
    pushIssue(issues, `${pathLabel}.thrashing_thresholds.version`, "must be 1");
  }
  if (typeof thresholds.defaults_profile !== "string" || !thresholds.defaults_profile.trim()) {
    pushIssue(issues, `${pathLabel}.thrashing_thresholds.defaults_profile`, "must be a non-empty string");
  }

  validateResponseProgression(
    thresholds.response_progression,
    issues,
    `${pathLabel}.thrashing_thresholds.response_progression`
  );

  if (!isPlainObject(thresholds.signals)) {
    pushIssue(issues, `${pathLabel}.thrashing_thresholds.signals`, "must be an object");
  } else {
    for (const signalId of THRASHING_SIGNAL_ORDER) {
      if (!Object.prototype.hasOwnProperty.call(thresholds.signals, signalId)) {
        pushIssue(issues, `${pathLabel}.thrashing_thresholds.signals`, `missing required signal '${signalId}'`);
        continue;
      }
      validateSignalConfig(
        signalId,
        thresholds.signals[signalId],
        issues,
        `${pathLabel}.thrashing_thresholds.signals.${signalId}`
      );
    }

    for (const key of Object.keys(thresholds.signals)) {
      if (!THRASHING_SIGNAL_ORDER.includes(key)) {
        pushIssue(issues, `${pathLabel}.thrashing_thresholds.signals.${key}`, "is not a canonical Phase 2.8 signal id");
      }
    }
  }

  const expectedRootKeys = new Set(["version", "defaults_profile", "response_progression", "signals"]);
  for (const key of Object.keys(thresholds)) {
    if (!expectedRootKeys.has(key)) {
      pushIssue(issues, `${pathLabel}.thrashing_thresholds.${key}`, "is not part of the canonical thresholds contract");
    }
  }

  return {
    ok: issues.length === 0,
    thresholds: issues.length === 0 ? thresholds : null,
    issues,
  };
}

export function loadThrashingThresholds({ cwd = process.cwd(), path = null } = {}) {
  const readResult = readThrashingThresholdsDocument({ cwd, path });
  if (!readResult.ok) {
    return {
      ...readResult,
      signal_ids: THRASHING_SIGNAL_ORDER,
    };
  }

  const validation = validateThrashingThresholdsDocument(readResult.document, {
    cwd,
    path: readResult.path,
  });

  if (!validation.ok) {
    return {
      ok: false,
      path: readResult.path,
      present: true,
      document: readResult.document,
      thresholds: null,
      signal_ids: THRASHING_SIGNAL_ORDER,
      errors: validation.issues,
    };
  }

  return {
    ok: true,
    path: readResult.path,
    present: true,
    document: readResult.document,
    thresholds: validation.thresholds,
    signal_ids: THRASHING_SIGNAL_ORDER,
    errors: [],
  };
}

export function renderThrashingThresholdsDocument(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}
