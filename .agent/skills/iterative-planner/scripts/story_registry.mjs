#!/usr/bin/env node
// Story Registry — enforcement + query tool for story_registry.json
//
// Usage:
//   node story_registry.mjs check                    Validate registry schema & file refs
//   node story_registry.mjs evidence [<story-id>]    Show close-time evidence readiness for one story or all incomplete stories
//   node story_registry.mjs freshness                Report age of registry (days, commits)
//   node story_registry.mjs diff <file> [<file>...]  Show stories affected by changed files
//   node story_registry.mjs summary                  One-line health summary
//   node story_registry.mjs --json                   Machine-readable output (combine with any command)
//
// Reads from: reports/user_story_audit/story_registry.json
// Exit codes: 0 = OK, 1 = validation errors found

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

// Validate that a value is a safe git commit hash (7–40 hex chars).
// Returns the trimmed hash or null if invalid.
function safeCommitHash(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[0-9a-f]{7,40}$/i.test(trimmed) ? trimmed : null;
}

const cwd = process.cwd();
const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
const EVIDENCE_FIELDS = ["code_refs", "test_refs", "validation_refs"];
const AUDIT_PACKET_REQUIRED_FILES = [
  "coverage_summary.md",
  "traceability_matrix.md",
  "findings.md",
  "remediation_plan.md",
];

function fileExistsForRef(ref) {
  const filePath = String(ref || "").split(":")[0];
  return existsSync(join(cwd, filePath));
}

function collectRefWarnings(story, field, warnings) {
  if (!Array.isArray(story[field])) return;
  const singular = field.replace(/s$/, "");
  for (const ref of story[field]) {
    if (!fileExistsForRef(ref)) {
      warnings.push(`${story.id}: ${singular} '${ref}' — file not found`);
    }
  }
}

function buildStoryEvidenceReport(story) {
  const issues = [];
  const counts = {};
  const status = story.status || "UNKNOWN";

  if (status === "RETIRED" || status === "NOT_IMPLEMENTED") {
    for (const field of EVIDENCE_FIELDS) {
      const refs = Array.isArray(story[field]) ? story[field] : [];
      counts[field] = refs.length;
    }
    return {
      id: story.id,
      title: story.title || "",
      status,
      counts,
      issues,
      evidence_ready: true,
      guidance: status === "RETIRED"
        ? "Retired stories are historical records and do not require an active evidence chain."
        : "Not-implemented stories are backlog records and do not require code/test/validation evidence until implementation begins.",
    };
  }

  for (const field of EVIDENCE_FIELDS) {
    const refs = Array.isArray(story[field]) ? story[field] : [];
    counts[field] = refs.length;

    if (refs.length === 0) {
      issues.push({
        field,
        type: "missing_field",
        message: `missing ${field}`,
      });
      continue;
    }

    for (const ref of refs) {
      if (!fileExistsForRef(ref)) {
        issues.push({
          field,
          type: "missing_file",
          ref,
          message: `${field} entry '${ref}' points to a missing file`,
        });
      }
    }
  }

  return {
    id: story.id,
    title: story.title || "",
    status,
    counts,
    issues,
    evidence_ready: issues.length === 0,
    guidance: issues.length === 0
      ? "Evidence chain inputs are present in story_registry.json."
      : "Update reports/user_story_audit/story_registry.json; @planner: annotations help coverage, but they do not create code_refs, test_refs, or validation_refs.",
  };
}

function summarizeEvidenceIssues(issues) {
  return (issues || []).map((issue) => issue.message).join("; ");
}

// ---------------------------------------------------------------------------
// Registry Access
// ---------------------------------------------------------------------------

function loadRegistry() {
  if (!existsSync(registryPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(registryPath, "utf-8"));
  } catch (e) {
    return { _parseError: e.message };
  }
}

function parseReportMetadata(content) {
  const text = String(content || "");
  const dateMatch = text.match(/^\*\*Date\*\*:\s*([^\n]+)$/m);
  const commitMatch = text.match(/^\*\*Registry commit\*\*:\s*`([^`]+)`$/m);
  return {
    date: dateMatch ? dateMatch[1].trim() : null,
    commit: commitMatch ? safeCommitHash(commitMatch[1]) : null,
    referencesCanonicalSource: /story_registry\.json/.test(text),
  };
}

function validateAuditPacket(registry) {
  const errors = [];
  const warnings = [];
  const expectedDate = registry?.updated ? String(registry.updated).slice(0, 10) : null;
  const expectedCommit = safeCommitHash(registry?.commit);
  const packetDir = join(cwd, "reports", "user_story_audit");
  const existingPacketFiles = AUDIT_PACKET_REQUIRED_FILES.filter((fileName) => existsSync(join(packetDir, fileName)));

  if (existingPacketFiles.length === 0) {
    return { errors, warnings };
  }

  for (const fileName of AUDIT_PACKET_REQUIRED_FILES) {
    const filePath = join(packetDir, fileName);
    if (!existsSync(filePath)) {
      warnings.push(`Audit packet file missing: ${fileName}`);
      continue;
    }

    let content = "";
    try {
      content = readFileSync(filePath, "utf-8");
    } catch (error) {
      errors.push(`${fileName}: unreadable (${error.message})`);
      continue;
    }

    const metadata = parseReportMetadata(content);
    if (!metadata.referencesCanonicalSource) {
      warnings.push(`${fileName}: missing canonical story_registry.json source marker`);
    }

    if (!metadata.date) {
      errors.push(`${fileName}: missing **Date** metadata`);
    } else if (expectedDate && metadata.date !== expectedDate) {
      errors.push(`${fileName}: packet date ${metadata.date} does not match story_registry.json updated date ${expectedDate}`);
    }

    if (expectedCommit) {
      if (!metadata.commit) {
        errors.push(`${fileName}: missing **Registry commit** metadata`);
      } else if (metadata.commit.toLowerCase() !== expectedCommit.toLowerCase()) {
        errors.push(`${fileName}: registry commit ${metadata.commit} does not match story_registry.json commit ${expectedCommit}`);
      }
    }
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Validation (check)
// ---------------------------------------------------------------------------

function validateRegistry(registry) {
  const errors = [];
  const warnings = [];

  // Schema checks
  if (typeof registry.version !== "number") {
    errors.push("Missing or invalid 'version' field (expected number)");
  }
  if (!registry.updated || isNaN(Date.parse(registry.updated))) {
    errors.push("Missing or invalid 'updated' field (expected ISO date string)");
  }
  if (!Array.isArray(registry.stories)) {
    errors.push("Missing or invalid 'stories' field (expected array)");
    return { errors, warnings };
  }

  const ids = new Set();
  for (const story of allRegistryStories(registry)) {
    // Required fields
    if (!story.id) {
      errors.push(`Story missing 'id' field: ${JSON.stringify(story).slice(0, 80)}`);
      continue;
    }
    if (ids.has(story.id)) {
      errors.push(`Duplicate story ID: ${story.id}`);
    }
    ids.add(story.id);

    if (!story.title) warnings.push(`${story.id}: missing 'title'`);
    if (!story.status) warnings.push(`${story.id}: missing 'status'`);

    const validStatuses = ["FULLY_COVERED", "PARTIALLY_COVERED", "NOT_IMPLEMENTED", "RETIRED"];
    if (story.status && !validStatuses.includes(story.status)) {
      warnings.push(`${story.id}: unknown status '${story.status}' (expected: ${validStatuses.join(", ")})`);
    }

    // Array fields
    for (const field of ["code_refs", "test_refs", "doc_refs", "validation_refs"]) {
      if (story[field] && !Array.isArray(story[field])) {
        errors.push(`${story.id}: '${field}' must be an array`);
      }
    }

    collectRefWarnings(story, "code_refs", warnings);
    collectRefWarnings(story, "test_refs", warnings);
    collectRefWarnings(story, "validation_refs", warnings);

    if (story.status === "FULLY_COVERED") {
      const evidence = buildStoryEvidenceReport(story);
      if (!evidence.evidence_ready) {
        errors.push(`${story.id}: FULLY_COVERED story is not evidence-ready (${summarizeEvidenceIssues(evidence.issues)})`);
      }
    }
  }

  // Consolidation checks
  if (Array.isArray(registry.consolidations)) {
    for (const c of registry.consolidations) {
      if (!c.surviving || !ids.has(c.surviving)) {
        errors.push(`Consolidation references unknown surviving story: ${c.surviving}`);
      }
      if (!Array.isArray(c.retired) || c.retired.length === 0) {
        warnings.push(`Consolidation for ${c.surviving}: missing or empty 'retired' array`);
      }
    }
  }

  const packetValidation = validateAuditPacket(registry);
  errors.push(...packetValidation.errors);
  warnings.push(...packetValidation.warnings);

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

function getFreshness(registry) {
  const result = { days: null, commits: null, stale: false };

  if (!registry || !registry.updated) return { ...result, days: Infinity, commits: Infinity, stale: true };

  const updatedDate = new Date(registry.updated);
  result.days = Math.floor((Date.now() - updatedDate.getTime()) / (1000 * 60 * 60 * 24));

  if (registry.commit) {
    const safeHash = safeCommitHash(registry.commit);
    if (safeHash) {
      try {
        const proc = spawnSync("git", ["rev-list", `${safeHash}..HEAD`, "--count"], {
          encoding: "utf-8", cwd, timeout: 10000,
        });
        const parsed = Number.parseInt((proc.stdout || "").trim(), 10);
        result.commits = Number.isNaN(parsed) ? 999 : parsed;
      } catch {
        result.commits = 999;
      }
    } else {
      result.commits = 999;
    }
  }

  result.stale = result.days > 14 || (result.commits !== null && result.commits > 15);
  return result;
}

// ---------------------------------------------------------------------------
// Diff (which stories are affected by a file change)
// ---------------------------------------------------------------------------

function diffFiles(files, registry) {
  return diffFilesDetailed(files, registry).affected;
}

function allRegistryStories(registry) {
  return [
    ...(Array.isArray(registry?.stories) ? registry.stories : []),
    ...(Array.isArray(registry?.infrastructure_stories) ? registry.infrastructure_stories : []),
  ];
}

function refMatchesFile(file, ref) {
  const normalizedFile = String(file || "").replace(/^\.\//, "");
  const refFile = String(ref || "").split(":")[0].replace(/^\.\//, "");
  if (!normalizedFile || !refFile) return false;
  // RP-015: segment-bounded suffix matching prevents utils.ts matching plan_utils.ts.
  return refFile === normalizedFile
    || normalizedFile.endsWith("/" + refFile)
    || refFile.endsWith("/" + normalizedFile);
}

function diffFilesDetailed(files, registry) {
  const stories = allRegistryStories(registry);
  if (!registry || stories.length === 0) return { affected: [], unmatched: [] };

  const affected = [];
  const matchedFiles = new Set();
  for (const file of files) {
    const normalizedFile = file.replace(/^\.\//, "");
    for (const story of stories) {
      const refs = [
        ...(story.code_refs || []),
        ...(story.test_refs || []),
        ...(story.validation_refs || []),
        ...(story.doc_refs || []),
      ];
      const matches = refs.some(ref => refMatchesFile(normalizedFile, ref));
      if (matches && !affected.find(a => a.id === story.id)) {
        affected.push({
          id: story.id,
          title: story.title,
          status: story.status,
          matchedFile: normalizedFile,
        });
      }
      if (matches) matchedFiles.add(normalizedFile);
    }
  }
  const unmatched = files
    .map(file => String(file || "").replace(/^\.\//, ""))
    .filter(Boolean)
    .filter(file => !matchedFiles.has(file));
  return { affected, unmatched };
}

// ---------------------------------------------------------------------------
// Output Formatters
// ---------------------------------------------------------------------------

function printCheck(registry, jsonMode) {
  if (registry._parseError) {
    const result = { status: "FAIL", errors: [`JSON parse error: ${registry._parseError}`], warnings: [] };
    if (jsonMode) { console.log(JSON.stringify(result, null, 2)); } else {
      console.log("❌ FAIL — story_registry.json is not valid JSON");
      console.log(`   ${registry._parseError}`);
    }
    process.exit(1);
  }

  const { errors, warnings } = validateRegistry(registry);
  const status = errors.length > 0 ? "FAIL" : warnings.length > 0 ? "WARN" : "PASS";

  if (jsonMode) {
    console.log(JSON.stringify({ status, errors, warnings, storyCount: allRegistryStories(registry).length }, null, 2));
  } else {
    const icon = status === "PASS" ? "✅" : status === "WARN" ? "⚠️" : "❌";
    console.log(`${icon} ${status} — ${allRegistryStories(registry).length} stories in registry`);
    for (const e of errors) console.log(`  ❌ ${e}`);
    for (const w of warnings) console.log(`  ⚠️  ${w}`);
  }

  process.exit(errors.length > 0 ? 1 : 0);
}

function printFreshness(registry, jsonMode) {
  const f = getFreshness(registry);

  if (jsonMode) {
    console.log(JSON.stringify(f, null, 2));
  } else {
    const icon = f.stale ? "🔴" : "🟢";
    const dayLabel = f.days === Infinity ? "NEVER UPDATED" : `${f.days}d ago`;
    const commitLabel = f.commits === null || f.commits === Infinity ? "unknown" : `${f.commits} commits ago`;
    console.log(`${icon} Registry freshness: ${dayLabel}, ${commitLabel}`);
    if (f.stale) console.log("   ⚠️  Registry is stale — run /red-team-user-story-audit to update");
  }
}

function printDiff(files, registry, jsonMode) {
  const { affected, unmatched } = diffFilesDetailed(files, registry);
  const status = unmatched.length > 0 ? "WARN" : affected.length > 0 ? "AFFECTED" : "PASS";

  if (jsonMode) {
    console.log(JSON.stringify({
      status,
      affected,
      count: affected.length,
      unmatched,
      unmatchedCount: unmatched.length,
    }, null, 2));
  } else {
    if (affected.length === 0 && unmatched.length === 0) {
      console.log("✅ No stories affected by the changed files.");
    } else {
      if (affected.length > 0) {
        console.log(`⚠️  ${affected.length} story/stories affected by changed files:\n`);
        for (const a of affected) {
          console.log(`  ${a.id} [${a.status}] — ${a.title}`);
          console.log(`    matched via: ${a.matchedFile}`);
        }
      }
      if (unmatched.length > 0) {
        console.log(`${affected.length > 0 ? "\n" : ""}⚠️  ${unmatched.length} changed file(s) have no story mapping:`);
        for (const file of unmatched) console.log(`  ${file}`);
      }
      console.log("\n  Consider re-running /red-team-user-story-audit to update coverage.");
    }
  }
}

function printEvidence(registry, storyId, jsonMode) {
  if (registry._parseError) {
    const result = { status: "FAIL", errors: [`JSON parse error: ${registry._parseError}`] };
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("❌ FAIL — story_registry.json is not valid JSON");
      console.log(`   ${registry._parseError}`);
    }
    process.exit(1);
  }

  const stories = allRegistryStories(registry);
  const allReports = stories.map(buildStoryEvidenceReport);

  if (storyId) {
    const report = allReports.find((entry) => entry.id === storyId);
    if (!report) {
      const result = { status: "FAIL", message: `Story not found: ${storyId}` };
      if (jsonMode) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`❌ Story not found: ${storyId}`);
      }
      process.exit(1);
    }

    const status = report.evidence_ready ? "PASS" : "WARN";
    if (jsonMode) {
      console.log(JSON.stringify({ status, story: report }, null, 2));
    } else {
      const icon = report.evidence_ready ? "✅" : "⚠️";
      console.log(`${icon} Evidence ${status} — ${report.id} [${report.status}] ${report.title}`);
      console.log(`  code_refs: ${report.counts.code_refs}`);
      console.log(`  test_refs: ${report.counts.test_refs}`);
      console.log(`  validation_refs: ${report.counts.validation_refs}`);
      if (report.issues.length > 0) {
        for (const issue of report.issues) console.log(`  ❌ ${issue.message}`);
      }
      console.log(`  Hint: ${report.guidance}`);
    }
    process.exit(report.evidence_ready ? 0 : 1);
  }

  const incomplete = allReports.filter((entry) => !entry.evidence_ready);
  const status = incomplete.length > 0 ? "WARN" : "PASS";
  if (jsonMode) {
    console.log(JSON.stringify({ status, incomplete_count: incomplete.length, stories: incomplete }, null, 2));
  } else if (incomplete.length === 0) {
    console.log("✅ All stories have code_refs, test_refs, and validation_refs present.");
  } else {
    console.log(`⚠️  ${incomplete.length} story/stories have incomplete close-time evidence:\n`);
    for (const report of incomplete) {
      const summary = report.issues.map((issue) => issue.message).join("; ");
      console.log(`  ${report.id} [${report.status}] — ${summary}`);
    }
    console.log(`\n  Hint: Update ${registryPath}; @planner: annotations do not replace story_registry evidence refs.`);
  }
  process.exit(incomplete.length > 0 ? 1 : 0);
}

function printSummary(registry, jsonMode) {
  if (!registry || !Array.isArray(registry.stories)) {
    const result = { exists: false, message: "No story registry found" };
    if (jsonMode) { console.log(JSON.stringify(result, null, 2)); } else { console.log("⚠️  No story registry found."); }
    return;
  }

  const total = registry.stories.length;
  const full = registry.stories.filter(s => s.status === "FULLY_COVERED").length;
  const partial = registry.stories.filter(s => s.status === "PARTIALLY_COVERED").length;
  const missing = registry.stories.filter(s => s.status === "NOT_IMPLEMENTED").length;
  const retired = registry.stories.filter(s => s.status === "RETIRED").length;
  const consolidations = registry.consolidations?.length || 0;
  const f = getFreshness(registry);

  if (jsonMode) {
    console.log(JSON.stringify({ total, full, partial, missing, retired, consolidations, freshness: f }, null, 2));
  } else {
    const active = total - retired;
    const coverage = active > 0 ? Math.round((full / active) * 100) : null;
    const coverageLabel = coverage !== null ? `${coverage}%` : "N/A (all retired)";
    const freshIcon = f.stale ? "🔴" : "🟢";
    console.log(`📊 Story Registry: ${total} stories, ${coverageLabel} covered | ${full} full, ${partial} partial, ${missing} missing, ${retired} retired | ${consolidations} consolidations | ${freshIcon} ${f.days === Infinity ? "never updated" : f.days + "d old"}`);
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// F-026 FIX: Guard CLI dispatch so the module can be imported without side effects
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (!isMain) {
  // Module is being imported — export utility functions only, no CLI dispatch
  // Consumers can import { validateRegistry, ... } once this guard is in place
}
if (isMain) {

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const filteredArgs = args.filter(a => a !== "--json");
const command = filteredArgs[0] || "summary";

const registry = loadRegistry();

if (command === "check") {
  if (!registry) {
    if (jsonMode) {
      console.log(JSON.stringify({ status: "SKIP", message: "No story_registry.json found" }, null, 2));
    } else {
      console.log("⚠️  No story_registry.json found — run /red-team-user-story-audit to create one.");
    }
    process.exit(0);
  }
  printCheck(registry, jsonMode);

} else if (command === "evidence") {
  if (!registry) {
    if (jsonMode) {
      console.log(JSON.stringify({ status: "SKIP", message: "No story_registry.json found" }, null, 2));
    } else {
      console.log("⚠️  No story registry — cannot inspect evidence readiness.");
    }
    process.exit(0);
  }
  printEvidence(registry, filteredArgs[1] || null, jsonMode);

} else if (command === "freshness") {
  printFreshness(registry, jsonMode);

} else if (command === "diff") {
  const files = filteredArgs.slice(1);
  if (files.length === 0) {
    console.error("ERROR: 'diff' requires at least one file path argument");
    process.exit(1);
  }
  if (!registry) {
    if (jsonMode) {
      console.log(JSON.stringify({ affected: [], count: 0, message: "No registry" }, null, 2));
    } else {
      console.log("⚠️  No story registry — cannot determine affected stories.");
    }
    process.exit(0);
  }
  printDiff(files, registry, jsonMode);

} else if (command === "summary") {
  printSummary(registry, jsonMode);

} else {
  console.error(`Unknown command: ${command}`);
  console.error("Usage: story_registry.mjs [check|evidence [story-id]|freshness|diff <files>|summary] [--json]");
  process.exit(1);
}

} // end isMain guard
