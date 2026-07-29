// Shared acceptance predicate helpers for learned-obligation artifacts.

export const ACCEPTANCE_PREDICATE_NAMES = new Set([
  "has_section",
  "regex_match",
  "numeric_range",
  "json_schema",
  "min_word_count",
  "references_baseline_named",
]);

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function splitArgs(rawArgs) {
  if (!rawArgs.trim()) return [];
  return rawArgs
    .split(",")
    .map((arg) => arg.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

export function normalizeAcceptanceCheck(check) {
  if (typeof check === "string") {
    const raw = check.trim();
    const match = raw.match(/^([A-Za-z_][A-Za-z0-9_-]*)\((.*)\)$/);
    if (!match) return null;
    return {
      predicate: match[1].trim().toLowerCase().replace(/-/g, "_"),
      args: splitArgs(match[2] || ""),
      raw,
    };
  }

  if (!check || typeof check !== "object" || Array.isArray(check)) return null;
  const predicate = firstNonEmptyString(check.predicate, check.name, check.type)?.toLowerCase().replace(/-/g, "_");
  if (!predicate) return null;
  return {
    ...check,
    predicate,
  };
}

function finiteNumber(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function validateAcceptanceCheck(check) {
  const normalized = normalizeAcceptanceCheck(check);
  if (!normalized) {
    return { valid: false, error: "invalid_acceptance_predicate", normalized: null };
  }

  const predicate = normalized.predicate;
  if (!ACCEPTANCE_PREDICATE_NAMES.has(predicate)) {
    return { valid: false, error: "invalid_acceptance_predicate", normalized };
  }

  const args = Array.isArray(normalized.args) ? normalized.args : [];
  if (predicate === "has_section") {
    const heading = firstNonEmptyString(normalized.heading, normalized.section, args[0]);
    return { valid: !!heading, error: heading ? null : "invalid_acceptance_predicate", normalized };
  }

  if (predicate === "regex_match") {
    const pattern = firstNonEmptyString(normalized.pattern, normalized.regex, args[0]);
    if (!pattern) return { valid: false, error: "invalid_acceptance_predicate", normalized };
    try {
      new RegExp(pattern);
      return { valid: true, error: null, normalized };
    } catch {
      return { valid: false, error: "invalid_acceptance_predicate", normalized };
    }
  }

  if (predicate === "numeric_range") {
    const min = finiteNumber(normalized.min ?? args[0]);
    const max = finiteNumber(normalized.max ?? args[1]);
    return { valid: min !== null && max !== null && min <= max, error: min !== null && max !== null && min <= max ? null : "invalid_acceptance_predicate", normalized };
  }

  if (predicate === "json_schema") {
    const schemaPath = firstNonEmptyString(normalized.path, normalized.schema_path, normalized.schemaPath, args[0]);
    const safe = !!schemaPath && !schemaPath.startsWith("/") && !schemaPath.split(/[\\/]+/).includes("..");
    return { valid: safe, error: safe ? null : "invalid_acceptance_predicate", normalized };
  }

  if (predicate === "min_word_count") {
    const count = finiteNumber(normalized.count ?? normalized.min ?? args[0]);
    return { valid: Number.isInteger(count) && count >= 0, error: Number.isInteger(count) && count >= 0 ? null : "invalid_acceptance_predicate", normalized };
  }

  if (predicate === "references_baseline_named") {
    const name = firstNonEmptyString(normalized.name, normalized.baseline, args[0]);
    return { valid: !!name, error: name ? null : "invalid_acceptance_predicate", normalized };
  }

  return { valid: false, error: "invalid_acceptance_predicate", normalized };
}

export function normalizeAcceptanceChecks(checks) {
  if (!Array.isArray(checks)) return [];
  return checks
    .map((check) => validateAcceptanceCheck(check))
    .filter((result) => result.valid)
    .map((result) => result.normalized);
}

export function hasSection(content, heading) {
  const expected = String(heading || "").trim().replace(/^#+\s*/, "");
  if (!expected) return false;
  const pattern = new RegExp(`^#{1,6}\\s+${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im");
  return pattern.test(String(content || ""));
}

export function countWords(content) {
  return String(content || "").trim().split(/\s+/).filter(Boolean).length;
}
