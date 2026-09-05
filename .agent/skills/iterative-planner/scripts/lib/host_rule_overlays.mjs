import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { createHash } from "crypto";

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

function classifyAgainstCanonicalBase({
  baseText,
  consumerText,
  allowSectionOverrides = false,
}) {
  const sourceSections = parseNumberedMarkdownSections(baseText);
  const consumerSections = parseNumberedMarkdownSections(consumerText);
  const sourceByTitle = new Map(
    sourceSections.map((section) => [normalizeTitle(section.title), section]),
  );
  const consumerByTitle = new Map(
    consumerSections.map((section) => [normalizeTitle(section.title), section]),
  );

  for (const sourceSection of sourceSections) {
    if (!consumerByTitle.has(normalizeTitle(sourceSection.title))) {
      return {
        status: "true_divergence",
        extra_sections: [],
        reason: `managed heading missing in consumer: ${sourceSection.heading}`,
      };
    }
  }

  const projectSections = [];
  const replacements = [];
  for (const consumerSection of consumerSections) {
    const sourceSection = sourceByTitle.get(normalizeTitle(consumerSection.title));
    if (!sourceSection) {
      projectSections.push(consumerSection);
      replacements.push({ section: consumerSection, replacement: "\n" });
      continue;
    }
    if (normalizeBody(consumerSection.body) !== normalizeBody(sourceSection.body)) {
      if (!allowSectionOverrides) {
        return {
          status: "true_divergence",
          extra_sections: [],
          reason: `managed section body modified in consumer: ${sourceSection.heading}`,
        };
      }
      projectSections.push(consumerSection);
      replacements.push({ section: consumerSection, replacement: sourceSection.raw });
    }
  }

  if (projectSections.length === 0) {
    return {
      status: "true_divergence",
      extra_sections: [],
      reason: "non-section text or preamble differences detected in rules.md",
    };
  }

  let reconstructed = String(consumerText);
  for (const item of replacements.sort((a, b) => b.section.start - a.section.start)) {
    reconstructed = `${reconstructed.slice(0, item.section.start)}${item.replacement}${reconstructed.slice(item.section.end)}`;
  }
  if (normalizeDocument(reconstructed) !== normalizeDocument(baseText)) {
    return {
      status: "true_divergence",
      extra_sections: projectSections,
      reason: "unmanaged non-section modifications detected in rules.md alongside project sections",
    };
  }

  return {
    status: "extractable",
    extra_sections: projectSections,
    reason: `found ${projectSections.length} extractable project section(s)`,
  };
}

export function classifyRulesMdDivergence({
  sourceText,
  consumerText,
  historicalSourceTexts = [],
  allowCurrentSectionOverrides = false,
}) {
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

  const currentResult = classifyAgainstCanonicalBase({
    baseText: sourceText,
    consumerText,
    allowSectionOverrides: false,
  });
  if (currentResult.status === "extractable") return currentResult;

  const seen = new Set([sourceText]);
  for (const historicalText of Array.isArray(historicalSourceTexts) ? historicalSourceTexts : []) {
    if (typeof historicalText !== "string" || seen.has(historicalText)) continue;
    seen.add(historicalText);
    if (normalizeDocument(historicalText) === consNorm) {
      return {
        status: "historical_identical",
        extra_sections: [],
        reason: "consumer rules.md matches a historical canonical projection",
      };
    }
    const historicalResult = classifyAgainstCanonicalBase({
      baseText: historicalText,
      consumerText,
      allowSectionOverrides: true,
    });
    if (historicalResult.status === "extractable") {
      return {
        ...historicalResult,
        historical_base: true,
      };
    }
  }
  if (allowCurrentSectionOverrides) {
    const currentOverrideResult = classifyAgainstCanonicalBase({
      baseText: sourceText,
      consumerText,
      allowSectionOverrides: true,
    });
    if (currentOverrideResult.status === "extractable") return currentOverrideResult;
  }
  return currentResult;
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
    const contents = typeof sec.raw === "string" && sec.raw.length > 0
      ? (sec.raw.endsWith("\n") ? sec.raw : `${sec.raw}\n`)
      : `${sec.heading}\n\n${cleanBody}\n`;

    let exists = false;
    let conflict = false;
    let resolvedFilename = filename;
    let resolvedRelativePath = relativePath;
    let resolvedAbsolutePath = absolutePath;
    if (overlayDir && existsSync(resolvedAbsolutePath)) {
      exists = true;
      try {
        const diskContent = readFileSync(resolvedAbsolutePath, "utf-8");
        if (normalizeBody(diskContent) !== normalizeBody(contents)) {
          const digest = createHash("sha256").update(contents).digest("hex").slice(0, 12);
          resolvedFilename = `${num}-${slug}-${digest}.md`;
          resolvedRelativePath = `.agent/rules/${resolvedFilename}`;
          resolvedAbsolutePath = join(overlayDir, resolvedFilename);
          exists = existsSync(resolvedAbsolutePath);
          if (exists) {
            const alternateContent = readFileSync(resolvedAbsolutePath, "utf-8");
            conflict = normalizeBody(alternateContent) !== normalizeBody(contents);
          }
        }
      } catch {
        conflict = true;
      }
    }

    return {
      number: num,
      slug,
      filename: resolvedFilename,
      relative_path: resolvedRelativePath,
      absolute_path: resolvedAbsolutePath,
      heading: sec.heading,
      contents,
      exists,
      conflict,
    };
  });
}

export function extractHostRuleOverlays(projectRoot, {
  dryRun = false,
  sourceText = null,
  historicalSourceTexts = [],
  allowCurrentSectionOverrides = false,
} = {}) {
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
    historicalSourceTexts,
    allowCurrentSectionOverrides,
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
