import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function listHostRuleOverlayFiles(projectRoot = process.cwd()) {
  const rulesDir = join(projectRoot, ".agent", "rules");
  if (!existsSync(rulesDir)) return [];
  try {
    return readdirSync(rulesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !/conflicted copy/i.test(entry.name))
      .map((entry) => join(rulesDir, entry.name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export function kebabCase(str) {
  return String(str || "")
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseNumberedMarkdownSections(text) {
  const src = String(text || "");
  const headingRegex = /^##\s+([0-9]+[a-zA-Z]?)\.\s+(.*)$/gm;
  const sections = [];
  const matches = [];

  let match;
  while ((match = headingRegex.exec(src)) !== null) {
    matches.push({
      start: match.index,
      headingLine: match[0],
      number: match[1],
      title: match[2].trim(),
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const nextStart = i + 1 < matches.length ? matches[i + 1].start : src.length;
    const raw = src.slice(current.start, nextStart);
    const body = raw.slice(current.headingLine.length);
    const cleanBody = body
      .replace(/^\s+/, "")
      .replace(/(\n\s*---\s*)*\s*$/, "")
      .trim();

    sections.push({
      heading: current.headingLine.trim(),
      number: current.number,
      title: current.title,
      start: current.start,
      end: nextStart,
      raw,
      body,
      cleanBody,
    });
  }

  return sections;
}

function normalizeTitle(title) {
  return String(title || "")
    .trim()
    .toLowerCase()
    .replace(/[\s—–-]+/g, " ");
}

function normalizeBody(body) {
  return String(body || "")
    .replace(/\r\n/g, "\n")
    .replace(/^\n+/, "")
    .replace(/(\n\s*---\s*)*\s*$/, "")
    .trimEnd();
}

function normalizeDocument(doc) {
  return String(doc || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/(\n\s*---\s*)+/g, "\n---\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/(\n\s*---\s*)*\s*$/, "")
    .trim();
}

export function classifyRulesMdDivergence({ sourceText, consumerText }) {
  if (
    sourceText === null
    || typeof sourceText !== "string"
    || consumerText === null
    || typeof consumerText !== "string"
  ) {
    return {
      status: "true_divergence",
      extra_sections: [],
      reason: "missing or unreadable source/consumer rules.md",
    };
  }

  if (sourceText === consumerText) {
    return {
      status: "identical",
      extra_sections: [],
      reason: "source and consumer rules.md are byte-identical",
    };
  }

  const srcNorm = normalizeDocument(sourceText);
  const consNorm = normalizeDocument(consumerText);
  if (srcNorm === consNorm) {
    return {
      status: "identical",
      extra_sections: [],
      reason: "source and consumer rules.md are whitespace-identical",
    };
  }

  const sourceSections = parseNumberedMarkdownSections(sourceText);
  const consumerSections = parseNumberedMarkdownSections(consumerText);

  // Map source sections by normalized title
  const sourceByTitle = new Map();
  for (const sec of sourceSections) {
    sourceByTitle.set(normalizeTitle(sec.title), sec);
  }

  // 1. Check that every source managed heading exists in consumer with identical body
  for (const srcSec of sourceSections) {
    const key = normalizeTitle(srcSec.title);
    const consSec = consumerSections.find((s) => normalizeTitle(s.title) === key);
    if (!consSec) {
      return {
        status: "true_divergence",
        extra_sections: [],
        reason: `managed heading missing in consumer: ${srcSec.heading}`,
      };
    }
    if (normalizeBody(consSec.body) !== normalizeBody(srcSec.body)) {
      return {
        status: "true_divergence",
        extra_sections: [],
        reason: `managed section body modified in consumer: ${srcSec.heading}`,
      };
    }
  }

  // 2. Identify extra sections in consumer that are NOT in source
  const extraSections = [];
  for (const consSec of consumerSections) {
    const key = normalizeTitle(consSec.title);
    if (!sourceByTitle.has(key)) {
      extraSections.push(consSec);
    }
  }

  if (extraSections.length === 0) {
    return {
      status: "true_divergence",
      extra_sections: [],
      reason: "non-section text or preamble differences detected in rules.md",
    };
  }

  // 3. Check that the extra sections are the ONLY non-whitespace difference
  let reconstructed = String(consumerText);
  for (const extra of extraSections) {
    reconstructed = reconstructed.replace(extra.raw, "\n");
  }

  if (normalizeDocument(reconstructed) !== srcNorm) {
    return {
      status: "true_divergence",
      extra_sections: extraSections,
      reason: "unmanaged non-section modifications detected in rules.md alongside extra sections",
    };
  }

  return {
    status: "extractable",
    extra_sections: extraSections,
    reason: `found ${extraSections.length} extractable host section(s)`,
  };
}

export function planHostRuleOverlayWrites({ extra_sections, overlayDir, startNumber = 40 }) {
  if (!Array.isArray(extra_sections)) return [];

  return extra_sections.map((sec, index) => {
    const num = startNumber + index;
    const title = sec.title || sec.heading.replace(/^##\s+([0-9]+[a-zA-Z]?)\.\s*/, "");
    const slug = kebabCase(title);
    const filename = `${num}-${slug}.md`;
    const relativePath = `.agent/rules/${filename}`;
    const absolutePath = overlayDir ? join(overlayDir, filename) : relativePath;
    const cleanBody = (sec.cleanBody || sec.body || "")
      .replace(/^\s+/, "")
      .replace(/(\n\s*---\s*)*\s*$/, "")
      .trim();
    const contents = `${sec.heading}\n\n${cleanBody}\n`;

    let exists = false;
    let conflict = false;
    if (overlayDir && existsSync(absolutePath)) {
      exists = true;
      try {
        const diskContent = readFileSync(absolutePath, "utf-8");
        if (normalizeBody(diskContent) !== normalizeBody(contents)) {
          conflict = true;
        }
      } catch {
        conflict = true;
      }
    }

    return {
      number: num,
      slug,
      filename,
      relative_path: relativePath,
      absolute_path: absolutePath,
      heading: sec.heading,
      contents,
      exists,
      conflict,
    };
  });
}

export function extractHostRuleOverlays(projectRoot, { dryRun = false, sourceText = null } = {}) {
  const rulesPath = join(projectRoot, ".agent", "rules.md");
  if (!existsSync(rulesPath)) {
    return {
      status: "identical",
      wrote: [],
      skipped: [],
      overlays: [],
      reason: "rules.md not found",
    };
  }

  let consumerText = "";
  try {
    consumerText = readFileSync(rulesPath, "utf-8");
  } catch (err) {
    return {
      status: "true_divergence",
      wrote: [],
      skipped: [],
      overlays: [],
      reason: `cannot read consumer rules.md: ${err.message}`,
    };
  }

  // If consumer working tree differs from HEAD, do not extract
  try {
    const headText = execFileSync("git", [
      "-c", "core.excludesfile=",
      "-C", projectRoot,
      "show", "HEAD:.agent/rules.md",
    ], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL || "/dev/null",
        GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM || "1",
        GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM || "/dev/null",
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || "/dev/null",
      },
    });
    if (headText !== consumerText) {
      return {
        status: "uncommitted_target",
        wrote: [],
        skipped: [],
        overlays: [],
        reason: "consumer working tree of .agent/rules.md differs from HEAD",
      };
    }
  } catch {
    // If not a git repo or file not in HEAD, proceed with consumerText
  }

  if (sourceText === null || typeof sourceText !== "string" || sourceText.length === 0) {
    return {
      status: "true_divergence",
      wrote: [],
      skipped: [],
      overlays: [],
      reason: "missing or unreadable source rules.md",
    };
  }

  const classification = classifyRulesMdDivergence({
    sourceText,
    consumerText,
  });

  if (classification.status !== "extractable") {
    return {
      status: classification.status,
      wrote: [],
      skipped: [],
      overlays: [],
      reason: classification.reason,
    };
  }

  const overlayDir = join(projectRoot, ".agent", "rules");
  const plan = planHostRuleOverlayWrites({
    extra_sections: classification.extra_sections,
    overlayDir,
  });

  const conflicting = plan.find((p) => p.conflict);
  if (conflicting) {
    return {
      status: "true_divergence",
      wrote: [],
      skipped: [],
      overlays: plan,
      reason: `existing overlay file differs in content: ${conflicting.relative_path}`,
    };
  }

  const wrote = [];
  const skipped = [];

  if (!dryRun) {
    mkdirSync(overlayDir, { recursive: true });
    for (const p of plan) {
      if (p.exists) {
        skipped.push(p.relative_path);
      } else {
        writeFileSync(p.absolute_path, p.contents, "utf-8");
        wrote.push(p.relative_path);
      }
    }
  } else {
    for (const p of plan) {
      if (p.exists) {
        skipped.push(p.relative_path);
      } else {
        wrote.push(p.relative_path);
      }
    }
  }

  return {
    status: "extractable",
    wrote,
    skipped,
    overlays: plan,
    reason: classification.reason,
  };
}
