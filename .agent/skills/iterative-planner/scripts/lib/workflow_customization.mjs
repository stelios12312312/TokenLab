import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

const PROJECT_REGISTRY_RELATIVE_PATH = join(".agent", "skills", "iterative-planner", "config", ".project_registry.json");
const WORKFLOW_DIR_RELATIVE_PATH = join(".agent", "workflows");
const INVENTORY_CONFIG_RELATIVE_PATH = join(".agent", "skills", "iterative-planner", "config", "workflow_migration_inventory.json");

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function md5(value) {
  return createHash("md5").update(String(value || ""), "utf-8").digest("hex");
}

function listWorkflowEntries(projectRoot) {
  const workflowDir = join(projectRoot, WORKFLOW_DIR_RELATIVE_PATH);
  if (!existsSync(workflowDir)) return [];
  return readdirSync(workflowDir)
    .filter((entry) => entry.endsWith(".md"))
    .sort()
    .map((entry) => ({
      workflow: `/${entry.replace(/\.md$/i, "")}`,
      relative_path: join(WORKFLOW_DIR_RELATIVE_PATH, entry),
      absolute_path: join(workflowDir, entry),
    }));
}

function readProjectRegistry(projectRoot) {
  return safeReadJson(join(projectRoot, PROJECT_REGISTRY_RELATIVE_PATH));
}

function buildSourceIssue({ code, severity = "error", path, message }) {
  return {
    code,
    severity,
    path,
    message,
  };
}

function resolveCanonicalSourceProject(projectRoot) {
  const registryPath = join(projectRoot, PROJECT_REGISTRY_RELATIVE_PATH);
  const sourcePath = readProjectRegistry(projectRoot)?.source_project_path;
  if (typeof sourcePath === "string" && sourcePath.trim()) {
    const resolved = resolve(sourcePath.trim());
    return {
      path: resolved,
      configured: true,
      available: existsSync(resolved),
      issue: existsSync(resolved)
        ? null
        : buildSourceIssue({
            code: "source_project_unavailable",
            path: resolved,
            message: "Canonical source project is unavailable, so workflow customization review cannot compare local workflows safely.",
          }),
    };
  }
  return {
    path: resolve(projectRoot),
    configured: false,
    available: false,
    issue: buildSourceIssue({
      code: "source_project_unconfigured",
      path: registryPath,
      message: "source_project_path is not configured, so workflow customization review cannot compare local workflows safely.",
    }),
  };
}

function readInventoryConfig(projectRoot) {
  const parsed = safeReadJson(join(projectRoot, INVENTORY_CONFIG_RELATIVE_PATH));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    return new Map();
  }
  return new Map(parsed.entries.map((entry) => [entry.workflow, entry]));
}

function extractHeadings(content) {
  const headings = [];
  const lines = String(content || "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{2,6})\s+(.+?)\s*$/.exec(lines[index]);
    if (!match) continue;
    headings.push({
      depth: match[1].length,
      title: match[2].trim(),
      line: index + 1,
    });
  }
  return headings;
}

function findSectionRange(headings, title, lineCount) {
  const index = headings.findIndex((entry) => entry.title === title);
  if (index === -1) return null;
  const current = headings[index];
  const next = headings.slice(index + 1).find((entry) => entry.depth <= current.depth);
  const endLine = next ? next.line - 1 : lineCount;
  return `${current.line}-${Math.max(current.line, endLine)}`;
}

function buildDiffSnippet(sourceContent, currentContent, limit = 8) {
  const sourceLines = String(sourceContent || "").split("\n");
  const currentLines = String(currentContent || "").split("\n");
  const diff = [];
  const max = Math.max(sourceLines.length, currentLines.length);
  for (let index = 0; index < max; index += 1) {
    if (sourceLines[index] === currentLines[index]) continue;
    if (sourceLines[index] !== undefined) diff.push(`-${sourceLines[index]}`);
    if (currentLines[index] !== undefined) diff.push(`+${currentLines[index]}`);
    if (diff.length >= limit) break;
  }
  return diff.join("\n");
}

function classifyCustomization({ workflow, localPath, sourcePath, localContent, sourceContent, inventoryEntry }) {
  if (localContent === sourceContent) return null;

  const sourceHeadings = extractHeadings(sourceContent);
  const localHeadings = extractHeadings(localContent);
  const sourceHeadingTitles = new Set(sourceHeadings.map((entry) => entry.title));
  const addedHeadings = localHeadings.filter((entry) => !sourceHeadingTitles.has(entry.title));
  const action = String(inventoryEntry?.v7_action || "").trim().toLowerCase();

  if (action === "deprecated") {
    return {
      workflow,
      file: localPath,
      type: "modified",
      action: "deprecate_on_migrate",
      rationale: `Workflow ${workflow} is deprecated in the migration inventory and should be reviewed before migration.`,
      diff: buildDiffSnippet(sourceContent, localContent),
    };
  }

  if (addedHeadings.length > 0) {
    const localLines = String(localContent || "").split("\n");
    return {
      workflow,
      file: localPath,
      type: "added_section",
      section: addedHeadings[0].title,
      lines: findSectionRange(localHeadings, addedHeadings[0].title, localLines.length),
      action: "preserve",
      rationale: "Local workflow adds a domain-specific section on top of the canonical template.",
    };
  }

  return {
    workflow,
    file: localPath,
    type: "modified_default",
    original_md5: md5(sourceContent),
    current_md5: md5(localContent),
    diff: buildDiffSnippet(sourceContent, localContent),
    action: "user_review",
    rationale: "Workflow differs from the canonical template and needs explicit review before migration or re-sync.",
  };
}

export function detectWorkflowCustomizations(projectRoot = process.cwd()) {
  const resolvedProjectRoot = resolve(projectRoot);
  const sourceProject = resolveCanonicalSourceProject(resolvedProjectRoot);
  const inventoryByWorkflow = readInventoryConfig(resolvedProjectRoot);
  const workflows = listWorkflowEntries(resolvedProjectRoot);
  const customizations = [];
  const issues = [];

  if (sourceProject.issue) {
    issues.push(sourceProject.issue);
  }

  if (sourceProject.available) {
    for (const entry of workflows) {
      const localContent = readText(entry.absolute_path);
      const sourceAbsolutePath = join(sourceProject.path, entry.relative_path);
      const sourceContent = readText(sourceAbsolutePath);
      if (localContent === null) continue;
      if (sourceContent === null) {
        issues.push(buildSourceIssue({
          code: "source_workflow_missing",
          path: sourceAbsolutePath,
          message: `Canonical source is missing ${entry.relative_path}, so workflow customization review is incomplete for ${entry.workflow}.`,
        }));
        continue;
      }
      const customization = classifyCustomization({
        workflow: entry.workflow,
        localPath: entry.relative_path,
        sourcePath: sourceAbsolutePath,
        localContent,
        sourceContent,
        inventoryEntry: inventoryByWorkflow.get(entry.workflow),
      });
      if (customization) customizations.push(customization);
    }
  }

  return {
    workflow_customizations: {
      version: 1,
      generated_at: new Date().toISOString(),
      project_root: resolvedProjectRoot,
      source_project_path: sourceProject.path,
      source_project_configured: sourceProject.configured,
      source_project_available: sourceProject.available,
      workflow_dir: WORKFLOW_DIR_RELATIVE_PATH,
      issue_count: issues.length,
      issues,
      customization_count: customizations.length,
      customizations,
    },
  };
}

export function formatWorkflowCustomizationText(document) {
  const payload = document.workflow_customizations;
  const lines = [];
  lines.push("Workflow customization detector");
  lines.push(`  Source project: ${payload.source_project_path}`);
  lines.push(`  Source configured: ${payload.source_project_configured ? "yes" : "no"}`);
  lines.push(`  Source available: ${payload.source_project_available ? "yes" : "no"}`);
  if (payload.issue_count > 0) {
    lines.push(`  Issues: ${payload.issue_count}`);
    for (const issue of payload.issues) {
      lines.push(`  - ${issue.code}: ${issue.message}`);
    }
  }
  lines.push(`  Customizations: ${payload.customization_count}`);

  for (const entry of payload.customizations) {
    lines.push(`  - ${entry.file}: ${entry.type} -> ${entry.action}`);
    if (entry.section) lines.push(`      Section: ${entry.section} (${entry.lines || "line range unavailable"})`);
    if (entry.rationale) lines.push(`      Why: ${entry.rationale}`);
  }

  if (payload.customizations.length === 0) {
    lines.push("  No local workflow customizations detected.");
  }

  return lines.join("\n");
}
