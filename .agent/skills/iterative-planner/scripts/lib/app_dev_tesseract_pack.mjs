// app_dev_tesseract_pack.mjs - deterministic app-dev pack checker.

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { relative, resolve } from "path";
import { normalizeVerificationStatus, verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

export const APP_DEV_TESSERACT_CHECK_IDS = Object.freeze({
  ASYNC_STATE: "async_state_coverage",
  ENV_SINGLE_OWNER: "env_var_single_reader",
  WEBHOOK_DELIVERY: "webhook_delivery_semantics",
  ROUTE_WIRING: "route_handler_wiring",
  MIGRATION_JOURNEY: "migration_journey",
});

const DEFAULT_MAX_FILES = 2500;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const TEXT_FILE_PATTERN = /\.(?:js|jsx|ts|tsx|mjs|cjs|py|php|md|json|yml|yaml|html|css|env|example)$/i;
const ALWAYS_TEXT_NAMES = new Set(["Dockerfile", "Procfile", ".env", ".env.example"]);
const EXCLUDED_DIRS = new Set([
  ".agent",
  ".agent.v6.backup",
  ".claude",
  ".git",
  ".next",
  ".venv",
  "__pycache__",
  "archive",
  "build",
  "coverage",
  "data",
  "dist",
  "docs",
  "node_modules",
  "plans",
  "recipes",
  "remote_plugin_files",
  "reports",
  "scratch",
  "tests",
  "vendor",
  "venv",
]);

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function isTextCandidate(name) {
  return TEXT_FILE_PATTERN.test(name) || ALWAYS_TEXT_NAMES.has(name);
}

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function safeRead(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function lineForIndex(text, index) {
  return String(text || "").slice(0, Math.max(0, index)).split(/\r?\n/).length;
}

function matchAllWithLine(regex, text) {
  const out = [];
  const source = String(text || "");
  regex.lastIndex = 0;
  let match = regex.exec(source);
  while (match) {
    out.push({ match, line: lineForIndex(source, match.index) });
    match = regex.exec(source);
  }
  return out;
}

function walkFiles(rootDir, { maxFiles = DEFAULT_MAX_FILES, maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
  const root = resolve(rootDir);
  const stack = [root];
  const files = [];
  const skipped = [];

  while (stack.length > 0 && files.length < maxFiles) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (err) {
      skipped.push({ path: normalizePath(relative(root, current)) || ".", reason: `unreadable:${err.code || "error"}` });
      continue;
    }

    for (const entry of entries) {
      if (entry.name === ".DS_Store") continue;
      const abs = resolve(current, entry.name);
      const rel = normalizePath(relative(root, abs));
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) {
          skipped.push({ path: rel, reason: "excluded_dir" });
          continue;
        }
        stack.push(abs);
        continue;
      }
      if (!entry.isFile() || !isTextCandidate(entry.name)) continue;
      const st = safeStat(abs);
      if (!st) continue;
      if (st.size > maxFileBytes) {
        skipped.push({ path: rel, reason: "too_large", bytes: st.size });
        continue;
      }
      files.push({ abs, rel, bytes: st.size, text: safeRead(abs) });
      if (files.length >= maxFiles) break;
    }
  }

  return { files: files.sort((a, b) => a.rel.localeCompare(b.rel)), skipped };
}

function statusFromFindings(findings) {
  if (findings.some((finding) => finding.severity === "fail")) return "FAIL";
  if (findings.some((finding) => finding.severity === "warn")) return "WARN";
  return "PASS";
}

function checkResult(id, label, surfaceCount, findings) {
  return {
    id,
    label,
    status: statusFromFindings(findings),
    surface_count: surfaceCount,
    finding_count: findings.length,
    findings,
    status_reason: surfaceCount === 0 ? "no_surface" : "checked",
  };
}

function finding({ checkId, severity, file, line = null, code, message, evidence = [] }) {
  return {
    check_id: checkId,
    severity,
    file,
    line,
    code,
    message,
    evidence,
  };
}

const ASYNC_SURFACE_RE = /\b(fetch\s*\(|axios\.|\$\.ajax\s*\(|wp\.apiFetch|wp_remote_(?:get|post)\s*\(|requests\.(?:get|post|put|delete)\s*\(|httpx\.|aiohttp\b)/i;
const ERROR_STATE_RE = /\b(catch\s*\(|try\s*{|except\b|error|failed|failure|onerror|throw new Error|reject|response\.ok|wp_send_json_error|st\.error)\b/i;
const LOADING_STATE_RE = /\b(loading|isLoading|setLoading|spinner|aria-busy|disabled|st\.spinner|st\.status|pending)\b/i;
const EMPTY_STATE_RE = /\b(empty|no data|no records|none found|fallback|placeholder|length\s*===\s*0|!\s*\w+\.length|st\.warning)\b/i;

function checkAsyncState(files) {
  const surfaces = files.filter((file) => ASYNC_SURFACE_RE.test(file.text));
  const findings = [];
  for (const file of surfaces) {
    const hasError = ERROR_STATE_RE.test(file.text);
    const hasLoading = LOADING_STATE_RE.test(file.text);
    const hasEmpty = EMPTY_STATE_RE.test(file.text);
    if (!hasError) {
      findings.push(finding({
        checkId: APP_DEV_TESSERACT_CHECK_IDS.ASYNC_STATE,
        severity: "fail",
        file: file.rel,
        code: "missing_async_error_state",
        message: "Async/API surface has no obvious error-state handling.",
      }));
    }
    if (hasError && (!hasLoading || !hasEmpty)) {
      findings.push(finding({
        checkId: APP_DEV_TESSERACT_CHECK_IDS.ASYNC_STATE,
        severity: "warn",
        file: file.rel,
        code: "missing_async_loading_or_empty_state",
        message: "Async/API surface has error handling but lacks obvious loading or empty-state coverage.",
        evidence: [
          hasLoading ? "loading_present" : "loading_missing",
          hasEmpty ? "empty_present" : "empty_missing",
        ],
      }));
    }
  }
  return checkResult(APP_DEV_TESSERACT_CHECK_IDS.ASYNC_STATE, "Async state coverage", surfaces.length, findings);
}

const ENV_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[['"`]([A-Z][A-Z0-9_]*)['"`]\]/g,
  /os\.getenv\(\s*['"`]([A-Z][A-Z0-9_]*)['"`]/g,
  /os\.environ\.get\(\s*['"`]([A-Z][A-Z0-9_]*)['"`]/g,
  /os\.environ\[['"`]([A-Z][A-Z0-9_]*)['"`]\]/g,
  /getenv\(\s*['"`]([A-Z][A-Z0-9_]*)['"`]/g,
  /\$_(?:ENV|SERVER)\[['"`]([A-Z][A-Z0-9_]*)['"`]\]/g,
];

function collectEnvReads(files) {
  const reads = new Map();
  for (const file of files) {
    for (const pattern of ENV_PATTERNS) {
      for (const { match, line } of matchAllWithLine(pattern, file.text)) {
        const name = match[1];
        if (!reads.has(name)) reads.set(name, []);
        reads.get(name).push({ file: file.rel, line });
      }
    }
  }
  return reads;
}

function checkEnvSingleOwner(files) {
  const reads = collectEnvReads(files);
  const findings = [];
  for (const [name, locations] of [...reads.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const uniqueLocations = [];
    const seen = new Set();
    for (const loc of locations) {
      const key = `${loc.file}:${loc.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueLocations.push(loc);
    }
    if (uniqueLocations.length <= 1) continue;
    findings.push(finding({
      checkId: APP_DEV_TESSERACT_CHECK_IDS.ENV_SINGLE_OWNER,
      severity: "fail",
      file: uniqueLocations[0].file,
      line: uniqueLocations[0].line,
      code: "duplicate_env_read",
      message: `Environment variable ${name} is read in ${uniqueLocations.length} places.`,
      evidence: uniqueLocations.slice(0, 8).map((loc) => `${loc.file}:${loc.line}`),
    }));
  }
  return checkResult(APP_DEV_TESSERACT_CHECK_IDS.ENV_SINGLE_OWNER, "Environment variable single owner", reads.size, findings);
}

const WEBHOOK_SURFACE_RE = /\bwebhook\b|register_rest_route|wp_ajax|@(?:router|app)\.(?:post|get)|\b(?:router|app)\.(?:post|get)\s*\(/i;
const WEBHOOK_SECRET_RE = /\b(signature|secret|nonce|hmac|verify|token)\b/i;
const WEBHOOK_IDEMPOTENCY_RE = /\b(idempot|dedupe|duplicate|event[_-]?id|delivery|order[_-]?id|request[_-]?id|transient|lock)\b/i;
const WEBHOOK_RETRY_RE = /\b(retry|backoff|attempt|replay|queue|dead.?letter)\b/i;

function checkWebhookDelivery(files) {
  const surfaces = files.filter((file) => WEBHOOK_SURFACE_RE.test(`${file.rel}\n${file.text}`));
  const findings = [];
  for (const file of surfaces) {
    const hasSecret = WEBHOOK_SECRET_RE.test(file.text);
    const hasIdempotency = WEBHOOK_IDEMPOTENCY_RE.test(file.text);
    const hasRetry = WEBHOOK_RETRY_RE.test(file.text);
    if (!hasSecret || (!hasIdempotency && !hasRetry)) {
      findings.push(finding({
        checkId: APP_DEV_TESSERACT_CHECK_IDS.WEBHOOK_DELIVERY,
        severity: "fail",
        file: file.rel,
        code: "webhook_missing_delivery_semantics",
        message: "Webhook-like surface lacks signature/secret proof or idempotency/retry semantics.",
        evidence: [
          hasSecret ? "secret_or_signature_present" : "secret_or_signature_missing",
          hasIdempotency ? "idempotency_present" : "idempotency_missing",
          hasRetry ? "retry_present" : "retry_missing",
        ],
      }));
    }
  }
  return checkResult(APP_DEV_TESSERACT_CHECK_IDS.WEBHOOK_DELIVERY, "Webhook delivery semantics", surfaces.length, findings);
}

const ROUTE_DECL_RE = /\b(register_rest_route|add_action\s*\(\s*['"]wp_ajax|@(?:router|app)\.(?:get|post|put|delete)|\b(?:router|app)\.(?:get|post|put|delete)\s*\()/i;
const HANDLER_SHAPE_RE = /\b(function|def|async\s+function|=>|class|return\s+|wp_send_json|jsonify|Response)\b/i;

function checkRouteHandlerWiring(files) {
  const surfaces = files.filter((file) => ROUTE_DECL_RE.test(file.text));
  const findings = [];
  for (const file of surfaces) {
    if (!HANDLER_SHAPE_RE.test(file.text)) {
      findings.push(finding({
        checkId: APP_DEV_TESSERACT_CHECK_IDS.ROUTE_WIRING,
        severity: "warn",
        file: file.rel,
        code: "route_missing_handler_shape",
        message: "Route declaration has no obvious handler or response shape in the same file.",
      }));
    }
  }
  return checkResult(APP_DEV_TESSERACT_CHECK_IDS.ROUTE_WIRING, "Route/handler wiring", surfaces.length, findings);
}

const MIGRATION_PATH_RE = /\b(migrations?|migrate|backfill|upgrade|reconcile)\b/i;
const MIGRATION_CODE_RE = /\b(function|def)\s+\w*(?:migrate|migration|backfill|upgrade|reconcile)\b|dbDelta\s*\(|ALTER\s+TABLE|CREATE\s+TABLE|register_activation_hook/i;
const MIGRATION_JOURNEY_RE = /\b(dry[- ]?run|rollback|before\/after|before and after|journey|checkpoint|resume|verify|verified|smoke test|idempotent|reversible)\b/i;

function checkMigrationJourney(files) {
  const surfaces = files.filter((file) => MIGRATION_PATH_RE.test(file.rel) || MIGRATION_CODE_RE.test(file.text));
  const findings = [];
  for (const file of surfaces) {
    if (!MIGRATION_JOURNEY_RE.test(file.text)) {
      findings.push(finding({
        checkId: APP_DEV_TESSERACT_CHECK_IDS.MIGRATION_JOURNEY,
        severity: "fail",
        file: file.rel,
        code: "migration_missing_journey_proof",
        message: "Migration/backfill/import surface lacks dry-run, rollback, checkpoint, or journey verification terms.",
      }));
    }
  }
  return checkResult(APP_DEV_TESSERACT_CHECK_IDS.MIGRATION_JOURNEY, "Migration journey proof", surfaces.length, findings);
}

export function scanAppDevTesseractProject(options = {}) {
  const rootDir = resolve(options.rootDir || options.root || process.cwd());
  const startedAt = new Date().toISOString();
  if (!existsSync(rootDir)) {
    return {
      schema_version: 1,
      pack_id: "app_dev_tesseract",
      status: "ERROR",
      root_dir: rootDir,
      generated_at: startedAt,
      error: `root does not exist: ${rootDir}`,
      checks: [],
      findings: [],
    };
  }

  const { files, skipped } = walkFiles(rootDir, options);
  const checks = [
    checkAsyncState(files),
    checkEnvSingleOwner(files),
    checkWebhookDelivery(files),
    checkRouteHandlerWiring(files),
    checkMigrationJourney(files),
  ];
  const findings = checks.flatMap((check) => check.findings.map((entry) => ({
    ...entry,
    label: check.label,
  })));
  const status = statusFromFindings(findings);

  return {
    schema_version: 1,
    pack_id: "app_dev_tesseract",
    status,
    root_dir: rootDir,
    generated_at: startedAt,
    files_scanned: files.length,
    skipped_count: skipped.length,
    skipped: skipped.slice(0, 50),
    checks,
    findings,
    counts: {
      pass: checks.filter((check) => verificationStatusIsPass(check.status, "gate")).length,
      warn: checks.filter((check) => {
        const status = normalizeVerificationStatus(check.status, "gate");
        return status.kind === "pending" && status.token !== "UNKNOWN";
      }).length,
      fail: checks.filter((check) => {
        const status = normalizeVerificationStatus(check.status, "gate");
        return !status.valid || status.token === "UNKNOWN" || status.kind === "fail";
      }).length,
      findings: findings.length,
    },
  };
}

export function summarizeAppDevTesseractReport(report) {
  if (!report || typeof report !== "object") return "App-dev tesseract report unavailable";
  const parts = [
    `status=${report.status}`,
    `files=${report.files_scanned || 0}`,
    `findings=${report.counts?.findings || 0}`,
  ];
  const failing = (report.checks || []).filter((check) => {
    const status = normalizeVerificationStatus(check.status, "gate");
    return !status.valid || status.token === "UNKNOWN" || status.kind === "fail";
  }).map((check) => check.id);
  if (failing.length > 0) parts.push(`failing_checks=${failing.join(",")}`);
  return parts.join(" ");
}
