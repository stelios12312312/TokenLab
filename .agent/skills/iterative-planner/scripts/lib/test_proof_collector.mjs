// test_proof_collector.mjs — Test-native proof collector and report ingestor.
//
// Extracts criterion and story proof from test files and structured test output
// (JUnit XML, Jest/Vitest JSON, Node test TAP, and test runner stdout) without
// requiring developers to write in-code @planner: comments in business logic.

// @planner:module test_proof_collector
import { readFileSync, existsSync, readdirSync, lstatSync } from "fs";
import { join, relative, extname } from "path";
import { sanitizeStrictId } from "./sanitize.mjs";
import { verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

const TEST_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".tsx", ".py", ".rs", ".go", ".rb"]);
const CRITERION_TAG_REGEX = /@(sc_[a-zA-Z0-9_]+|crit:[a-zA-Z0-9_]+|criterion:[a-zA-Z0-9_]+)(?![a-zA-Z0-9_:-])/gi;

// ── Test File Scanner ────────────────────────────────────────────────────────

export function scanTestFileForProof(filePath, content) {
  if (typeof content !== "string") return [];
  const results = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match;
    CRITERION_TAG_REGEX.lastIndex = 0;
    while ((match = CRITERION_TAG_REGEX.exec(line)) !== null) {
      let rawId = match[1];
      if (/^crit(?:erion)?:/i.test(rawId)) {
        rawId = rawId.split(":")[1];
      }
      results.push({
        file: filePath,
        criterionId: rawId.toLowerCase(),
        line: i + 1,
        matchText: match[0],
      });
    }
  }

  return results;
}

export function scanTestDirectory(dir, baseDir = dir) {
  if (!existsSync(dir)) return [];
  const files = [];

  function walk(current, depth = 0) {
    if (depth > 40 || files.length > 10000) throw new Error("Test scan exceeds traversal limit");
    let entries;
    try { entries = readdirSync(current); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
      const full = join(current, entry);
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else if (st.isFile() && TEST_EXTENSIONS.has(extname(entry))) {
        if (st.size > 1024 * 1024) throw new Error("Test source exceeds size limit");
        files.push(full);
      }
    }
  }

  walk(dir);
  const proofs = [];
  for (const f of files) {
    const content = readFileSync(f, "utf-8");
    const rel = relative(baseDir, f).replace(/\\/g, "/");
    proofs.push(...scanTestFileForProof(rel, content));
  }
  return proofs;
}

// ── Test Report Ingestion (JUnit XML / JSON / TAP) ───────────────────────────

export function parseTestRunnerReport(rawContent, format = "auto") {
  if (typeof rawContent !== "string") return [];
  if (Buffer.byteLength(rawContent) > 1024 * 1024) throw new Error("Test report exceeds 1 MiB limit");
  const trimmed = rawContent.trim();
  if (!trimmed) return [];

  let detectedFormat = format;
  if (detectedFormat === "auto") {
    if (trimmed.startsWith("<") && trimmed.includes("<testcase")) detectedFormat = "junit";
    else if (trimmed.startsWith("{") || trimmed.startsWith("[")) detectedFormat = "json";
    else if (/^TAP version|^ok \d+|^not ok \d+/m.test(trimmed)) detectedFormat = "tap";
    else detectedFormat = "stdout";
  }

  switch (detectedFormat) {
    case "junit":
      return parseJUnitReport(trimmed);
    case "json":
      return parseJsonReport(trimmed);
    case "tap":
      return parseTapReport(trimmed);
    case "stdout":
    default:
      return parseStdoutReport(trimmed);
  }
}

function extractCriterionIdsFromTitle(title) {
  const ids = [];
  CRITERION_TAG_REGEX.lastIndex = 0;
  let match;
  while ((match = CRITERION_TAG_REGEX.exec(title)) !== null) {
    let rawId = match[1];
    if (/^crit(?:erion)?:/i.test(rawId)) {
      rawId = rawId.split(":")[1];
    }
    ids.push(rawId.toLowerCase());
  }
  return ids;
}

function parseJUnitReport(xml) {
  const tests = [], stack = [];
  let position = 0, current = null, roots = 0;
  const decode = value => value.replace(/&([^;]+);/g, (_, entity) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    if (!/^#(?:x[0-9a-f]+|\d+)$/i.test(entity)) throw new Error("Unknown XML entity");
    const n = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (n < 1 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw new Error("Invalid XML character");
    return String.fromCodePoint(n);
  });
  try {
    while (position < xml.length) {
      const start = xml.indexOf("<", position);
      if (start < 0) {
        if (!stack.length && xml.slice(position).trim()) throw new Error("Trailing XML text");
        position = xml.length;
        break;
      }
      if (!stack.length && xml.slice(position, start).trim()) throw new Error("Text outside root");
      if (xml.startsWith("<!--", start) || xml.startsWith("<![CDATA[", start) || xml.startsWith("<?xml", start)) {
        const terminator = xml.startsWith("<!--", start) ? "-->" : xml.startsWith("<![CDATA[", start) ? "]]>" : "?>";
        const end = xml.indexOf(terminator, start + 4);
        if (end < 0) throw new Error("Unterminated XML section");
        position = end + terminator.length;
        continue;
      }
      let end = start + 1, quote = null;
      for (; end < xml.length; end++) {
        const c = xml[end];
        if (quote) { if (c === quote) quote = null; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
        else if (c === "<") throw new Error("Malformed XML tag");
      }
      if (end === xml.length) throw new Error("Unterminated XML tag");
      const token = xml.slice(start + 1, end);
      position = end + 1;
      const close = /^\/([A-Za-z_][\w:.-]*)\s*$/.exec(token);
      if (close) {
        if (stack.pop() !== close[1]) throw new Error("Unbalanced XML");
        if (close[1] === "testcase") { tests.push(current); current = null; }
        continue;
      }
      const open = /^([A-Za-z_][\w:.-]*)/.exec(token);
      if (!open) throw new Error("Unsupported XML declaration");
      const name = open[1], attrs = Object.create(null);
      const selfClosing = /\/\s*$/.test(token);
      const rest = token.slice(name.length).replace(/\/\s*$/, "");
      const attribute = /\s+([A-Za-z_][\w:.-]*)\s*=\s*("([^"<]*)"|'([^'<]*)')/y;
      let offset = 0;
      while (offset < rest.length && rest.slice(offset).trim()) {
        attribute.lastIndex = offset;
        const m = attribute.exec(rest);
        if (!m || Object.hasOwn(attrs, m[1])) throw new Error("Invalid XML attribute");
        attrs[m[1]] = decode(m[3] ?? m[4]);
        offset = attribute.lastIndex;
      }
      if (!stack.length && ++roots > 1) throw new Error("Multiple XML roots");
      if (name === "testcase") {
        if (current || typeof attrs.name !== "string") throw new Error("Invalid testcase");
        current = {
          name: attrs.name, file: attrs.file || attrs.classname || "unknown",
          passed: !attrs.status || ["run", "passed"].includes(attrs.status),
          durationMs: Math.round((Number(attrs.time) || 0) * 1000),
          criterionIds: extractCriterionIdsFromTitle(attrs.name),
        };
        if (selfClosing) { tests.push(current); current = null; }
      } else if (current && ["failure", "error", "skipped"].includes(name)) current.passed = false;
      if (!selfClosing) {
        stack.push(name);
        if (stack.length > 64) throw new Error("XML nesting exceeds limit");
      }
    }
    if (stack.length || current || roots !== 1) throw new Error("Incomplete XML");
    return tests;
  } catch {
    // A malformed document has no trustworthy per-test results.
    return [];
  }
}

function parseJsonReport(jsonStr) {
  try {
    const data = JSON.parse(jsonStr);
    const tests = [];

    // Format 1: Jest / Vitest standard JSON report
    if (Array.isArray(data.testResults)) {
      for (const suite of data.testResults) {
        const file = suite.name || "unknown";
        if (Array.isArray(suite.assertionResults)) {
          for (const assertion of suite.assertionResults) {
            const name = assertion.fullName || assertion.title || "unnamed";
            tests.push({
              name,
              file,
              passed: data.success !== false && suite.status !== "failed" && verificationStatusIsPass(assertion.status, "evidence") && assertion.pending !== true && assertion.todo !== true,
              durationMs: assertion.duration || 0,
              criterionIds: extractCriterionIdsFromTitle(name),
            });
          }
        }
      }
      return tests;
    }

    // Format 2: Direct array of test objects
    if (Array.isArray(data)) {
      for (const item of data) {
        const name = item.name || item.title || "unnamed";
        tests.push({
          name,
          file: item.file || "unknown",
          passed: (item.passed === undefined || item.passed === true) &&
            (item.status === undefined ? item.passed === true : verificationStatusIsPass(item.status, "evidence")) &&
            item.skipped !== true && item.todo !== true && item.pending !== true,
          durationMs: item.durationMs || 0,
          criterionIds: extractCriterionIdsFromTitle(name),
        });
      }
      return tests;
    }

    return tests;
  } catch {
    return [];
  }
}

function parseTapReport(tapStr) {
  const tests = [];
  const lines = tapStr.split("\n");

  for (const line of lines) {
    const okMatch = line.match(/^\s*(ok|not ok)\s+(\d+)\s*(?:-\s*)?(.+)$/);
    if (okMatch) {
      const passed = okMatch[1] === "ok" && !/#\s*(?:SKIP|TODO)\b/i.test(okMatch[3]) && !/^\s*Bail out!/im.test(tapStr);
      const title = okMatch[3].trim();
      tests.push({
        name: title,
        file: "tap_output",
        passed,
        durationMs: 0,
        criterionIds: extractCriterionIdsFromTitle(title),
      });
    }
  }

  return tests;
}

function parseStdoutReport(stdout) {
  return stdout.split("\n").flatMap(line => {
    const criterionIds = extractCriterionIdsFromTitle(line);
    return criterionIds.length ? [{ name: line.trim(), file: "stdout", passed: false, durationMs: 0, criterionIds }] : [];
  });
}

// Declarations are not execution authority. In particular, arbitrary imported
// reports must not emit annotation aliases or criterion_executed_pass facts.
// A future runner integration must bind observations to the current plan/run.
export function generatePrologProofFacts(scanProofs = [], reportTests = []) {
  const facts = new Set();
  for (const proof of scanProofs) {
    if (typeof proof.file !== "string" || typeof proof.criterionId !== "string") continue;
    // Reject lossy sanitizer mappings rather than merging distinct identities.
    if (sanitizeStrictId(proof.file) !== "'" + proof.file + "'" ||
        !/^[a-z][a-z0-9_]*$/.test(proof.criterionId)) continue;
    facts.add("test_proves_criterion(" + sanitizeStrictId(proof.file) + ", " + sanitizeStrictId(proof.criterionId) + ").");
  }
  return [...facts].join("\n");
}
