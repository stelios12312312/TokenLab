import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { extname, join, relative, resolve } from "path";

export const DEFAULT_SCAN_ROOTS = ["src", "tests"];
export const SUPPORTED_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".tsx", ".py", ".go", ".rb"]);
const COMMENT_PREFIXES = {
  ".js": ["//"],
  ".mjs": ["//"],
  ".ts": ["//"],
  ".tsx": ["//"],
  ".py": ["#"],
  ".go": ["//"],
  ".rb": ["#"],
};
const EXCLUDED_SEGMENTS = new Set(["node_modules", ".git", "plans", "reports", "roadmap_v7", "docs"]);
const TAG_ALIASES = new Map([["story", "story_id"]]);
const ALLOWED_TAGS = new Set([
  "story_id",
  "tested_by",
  "accepts",
  "conflicts_with",
  "remediation",
  "obligation",
]);

function stripQuotes(value) {
  const text = String(value || "").trim();
  if (!text) return text;
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function normalizeTag(rawTag) {
  const normalized = String(rawTag || "").trim().toLowerCase();
  return TAG_ALIASES.get(normalized) || normalized;
}

function isTestPath(relativePath) {
  return /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\./i.test(String(relativePath || ""));
}

function shouldSkipDirectory(name) {
  return EXCLUDED_SEGMENTS.has(String(name || "").trim());
}

function shouldScanFile(filePath) {
  return SUPPORTED_EXTENSIONS.has(extname(filePath));
}

function walkFiles(rootDir, currentDir = rootDir, files = []) {
  if (!existsSync(currentDir)) return files;
  for (const entry of readdirSync(currentDir)) {
    if (shouldSkipDirectory(entry)) continue;
    const fullPath = join(currentDir, entry);
    let stats;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      walkFiles(rootDir, fullPath, files);
      continue;
    }
    if (stats.isFile() && shouldScanFile(fullPath)) {
      files.push(relative(rootDir, fullPath));
    }
  }
  return files;
}

function parseAnnotationLine(line, prefixes) {
  const trimmed = String(line || "").trim();
  let stripped = null;
  for (const prefix of prefixes) {
    if (trimmed.startsWith(prefix)) {
      stripped = trimmed.slice(prefix.length).trim();
      break;
    }
  }
  if (!stripped || !stripped.startsWith("@planner:")) return null;

  const body = stripped.slice("@planner:".length).trim();
  const match = body.match(/^([a-z_]+)(?:\s*(?:=|:)\s*|\s+)(.+)$/i);
  if (!match) return null;
  const tag = normalizeTag(match[1]);
  if (!ALLOWED_TAGS.has(tag)) return null;
  const value = stripQuotes(match[2]);
  if (!value) return null;
  return { tag, value, raw: stripped };
}

function detectSymbol(line, extension) {
  const text = String(line || "").trim();
  if (!text) return null;

  if ([".js", ".mjs", ".ts", ".tsx"].includes(extension)) {
    let match = text.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/);
    if (match) return match[1];
    match = text.match(/^(?:export\s+)?class\s+([A-Za-z0-9_$]+)/);
    if (match) return match[1];
    match = text.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/);
    if (match) return match[1];
  }

  if (extension === ".py") {
    const match = text.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)/) || text.match(/^class\s+([A-Za-z0-9_]+)/);
    if (match) return match[1];
  }

  if (extension === ".go") {
    const match = text.match(/^func\s+([A-Za-z0-9_]+)/);
    if (match) return match[1];
  }

  if (extension === ".rb") {
    const match = text.match(/^def\s+([A-Za-z0-9_?!]+)/) || text.match(/^class\s+([A-Za-z0-9_]+)/);
    if (match) return match[1];
  }

  return null;
}

function finalizeRecord(filePath, extension, pending, contextLine, scope) {
  if (!pending || pending.length === 0) return null;
  const tags = {};
  for (const item of pending) {
    if (!tags[item.tag]) tags[item.tag] = [];
    tags[item.tag].push(item.value);
  }
  return {
    file: filePath,
    line: pending[0].line,
    symbol: detectSymbol(contextLine, extension),
    scope,
    tags,
    raw: pending.map((item) => item.raw),
  };
}

function parseFile(projectRoot, relativePath) {
  const fullPath = join(projectRoot, relativePath);
  const extension = extname(relativePath);
  const prefixes = COMMENT_PREFIXES[extension];
  if (!prefixes) return [];

  const scope = isTestPath(relativePath) ? "test" : "source";
  const content = readFileSync(fullPath, "utf8");
  const lines = content.split("\n");
  const records = [];
  let pending = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const parsed = parseAnnotationLine(line, prefixes);
    if (parsed) {
      pending.push({ ...parsed, line: index + 1 });
      continue;
    }

    if (pending.length === 0) continue;
    if (!String(line || "").trim()) continue;

    const record = finalizeRecord(relativePath, extension, pending, line, scope);
    if (record) records.push(record);
    pending = [];
  }

  if (pending.length > 0) {
    const record = finalizeRecord(relativePath, extension, pending, "", scope);
    if (record) records.push(record);
  }

  return records;
}

export function extractAnnotations({ projectRoot = process.cwd(), roots = DEFAULT_SCAN_ROOTS } = {}) {
  const resolvedRoot = resolve(projectRoot);
  const files = [];
  const ignoredRoots = [];

  for (const root of roots) {
    const absoluteRoot = resolve(resolvedRoot, root);
    if (!existsSync(absoluteRoot)) {
      ignoredRoots.push(root);
      continue;
    }
    walkFiles(resolvedRoot, absoluteRoot, files);
  }

  const uniqueFiles = [...new Set(files)].sort();
  const records = uniqueFiles.flatMap((filePath) => parseFile(resolvedRoot, filePath));
  return {
    project_root: resolvedRoot,
    scan_roots: roots,
    ignored_roots: ignoredRoots,
    files_scanned: uniqueFiles,
    records,
  };
}
