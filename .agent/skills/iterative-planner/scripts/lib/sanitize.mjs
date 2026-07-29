// sanitize.mjs — Prolog atom sanitization and formatting helpers.
//
// Extracted from rule_engine.mjs to reduce file size and isolate
// security-critical sanitization logic for focused review.
//
// Security controls preserved:
//   AV-16:  Strip control characters, neutralize clause-terminating patterns
//   RT-AUDIT-M1: Whitelist-based sanitizer for structured identifiers
//
// Zero dependencies — Node.js 18+.

// ═══════════════════════════════════════════════════════════
// Prolog atom sanitization
// ═══════════════════════════════════════════════════════════

/**
 * Return a single-quoted Prolog atom. General-purpose escaper for free-text
 * (titles, descriptions). Always quotes to prevent IDs like 'RE-001' from
 * being mis-tokenized as arithmetic expressions.
 *
 * AV-16: Hardened — strip control characters, parentheses, periods, and
 * clause operators that could break out of quoted atom context.
 */
export function sanitizeAtom(s) {
  // RT10-C3: Allowlist-based sanitization — only permit safe characters.
  // Previous blocklist approach had gaps: dangling commas, nested functors,
  // pipe operators, and arithmetic injection could bypass individual filters.
  // Allowlist is simpler and provably safe: anything not explicitly allowed
  // is replaced with underscore.
  const str = String(s || "unknown")
    .replace(/[^a-zA-Z0-9_ ,.\-+#@=/&\n\r\t]/g, "_") // RT10-C3: Allowlist only safe chars (no colon — prevents :- rule injection)
    .replace(/__proto__|constructor|prototype/gi, "_blocked_") // RT6-H2: Prevent prototype pollution
    .replace(/\s+/g, " ")            // Normalize whitespace
    .trim()
    .slice(0, 500);                   // Length cap to prevent DoS
  return `'${str || "unknown"}'`;
}

/**
 * RT-AUDIT-M1: Whitelist-based sanitizer for structured identifiers (story IDs,
 * file paths, dependency refs). Only allows [a-zA-Z0-9_./:-] — rejects anything
 * that could construct Prolog syntax (parentheses, quotes, backslash, semicolon).
 */
export function sanitizeStrictId(s) {
  const clean = String(s || "unknown")
    .replace(/[^a-zA-Z0-9_./:@-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 200);
  return `'${clean || "unknown"}'`;
}

/**
 * Return a lowercase single-quoted Prolog atom for enum fields (priority, status).
 * Normalises to snake_case so predicate tests like `Status \= fully_covered` work
 * regardless of JSON casing.
 */
export function sanitizeEnumAtom(s) {
  const clean = String(s || "unknown").toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return `'${clean || "unknown"}'`;
}

// ═══════════════════════════════════════════════════════════
// Deduplication & formatting
// ═══════════════════════════════════════════════════════════

/**
 * Deduplicate invariant violations for pair(S1, S2) results (e.g. circular_dependency).
 * Both directions may be reported from Prolog; normalize by sorting the pair and dedup via Set.
 */
export function deduplicateViolations(violations) {
  const seen = new Set();
  return violations.filter(v => {
    const detail = v.Detail;
    if (detail && typeof detail === "object" && detail.functor === "pair" && detail.args?.length === 2) {
      const [a, b] = [String(detail.args[0]), String(detail.args[1])].sort();
      const key = `${v.Name}:${a}:${b}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  });
}

/**
 * Format a Prolog reason term into a human-readable string.
 */
export function formatReason(reason) {
  if (typeof reason === "string") return reason;
  if (typeof reason === "object" && reason !== null) {
    if (reason.functor) return `${reason.functor}(${reason.args.map(formatReason).join(", ")})`;
    if (Array.isArray(reason)) return reason.map(formatReason).join(", ");
    return JSON.stringify(reason);
  }
  return String(reason);
}
