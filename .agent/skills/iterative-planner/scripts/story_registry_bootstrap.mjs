#!/usr/bin/env node
// story_registry_bootstrap.mjs — Bootstrap story_registry.json from annotations and persona findings.
//
// Synthesises three sources of story evidence into a draft story_registry.json:
//   1. @planner: annotations in source code (via annotation_parser.mjs)
//   2. Persona pack audit findings (capability gaps → story candidates)
//   3. [Future] EXPLORE dialogue answers written to findings.md ## Story Candidates
//
// The bootstrap is idempotent: existing story IDs and titles are never overwritten.
// New stories are appended with the next available US-NNN ID.
//
// Usage:
//   node story_registry_bootstrap.mjs                  Run in cwd, write registry
//   node story_registry_bootstrap.mjs --dry-run        Show candidates, do not write
//   node story_registry_bootstrap.mjs --json           JSON output (machine-readable)
//   node story_registry_bootstrap.mjs --dir <path>     Override project root
//   node story_registry_bootstrap.mjs --help           Show this help

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { emitJson } from "./lib/emit_json.mjs";
import { getSkillPath, getPaths, readFindingsMarkdown } from "./lib/plan_utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const skillPath  = getSkillPath(import.meta.url);

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flags = {
  dryRun: args.includes("--dry-run"),
  json:   args.includes("--json"),
  help:   args.includes("--help") || args.includes("-h"),
};
const dirIdx = args.indexOf("--dir");
const cwdOverride = dirIdx !== -1 ? resolve(args[dirIdx + 1]) : null;
const cwd = cwdOverride || process.cwd();

if (flags.help) {
  console.log(`story_registry_bootstrap.mjs — Bootstrap story_registry.json from annotations + persona findings

Usage:
  node story_registry_bootstrap.mjs                  Run in cwd, write registry
  node story_registry_bootstrap.mjs --dry-run        Show candidates, do not write
  node story_registry_bootstrap.mjs --json           JSON output (machine-readable)
  node story_registry_bootstrap.mjs --dir <path>     Override project root
  node story_registry_bootstrap.mjs --help           Show this help

Sources:
  1. @planner: annotations in source files (annotation_parser.mjs)
  2. Persona audit findings — capability gaps (audit_runner.mjs)
  3. Story Candidates section in findings.md (dialogue-driven, optional)

The registry is written to reports/user_story_audit/story_registry.json.
Re-running is safe — existing entries are never overwritten.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Registry I/O
// ---------------------------------------------------------------------------

const REGISTRY_DIR  = join(cwd, "reports", "user_story_audit");
const REGISTRY_PATH = join(REGISTRY_DIR, "story_registry.json");

function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) return { stories: [] };
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  } catch {
    console.error(`  ⚠️ story_registry.json exists but is invalid JSON — treating as empty`);
    return { stories: [] };
  }
}

function nextId(stories) {
  let max = 0;
  for (const s of stories) {
    const m = (s.id || "").match(/^US-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

function formatId(n) {
  return `US-${String(n).padStart(3, "0")}`;
}

function parseIdNumber(storyId) {
  const match = String(storyId || "").match(/^US-(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

function uniqueList(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

// ---------------------------------------------------------------------------
// Source 1: @planner: annotations → story candidates
// ---------------------------------------------------------------------------

async function candidatesFromAnnotations() {
  const candidates = [];
  try {
    const parserPath = join(skillPath, "scripts", "annotation_parser.mjs");
    if (!existsSync(parserPath)) {
      console.error("  ⚠️ annotation_parser.mjs not found — skipping annotation scan");
      return candidates;
    }
    const { parseAnnotations, walkDir } = await import(parserPath);
    const files = walkDir(cwd, cwd);

    // Group annotations by file; extract module/story/capability annotations
    for (const filePath of files) {
      const annotations = parseAnnotations(filePath, cwd);
      if (!annotations || annotations.length === 0) continue;

      // Look for @planner:module / @planner:capability — together they describe one component
      const moduleAnn = annotations.find(a => a.key === "module" && a.value);
      const capabilityLabels = uniqueList(
        annotations
          .filter(a => a.key === "capability" && a.value)
          .map(a => a.value)
      );
      const storyAnns  = annotations.filter(a => a.key === "story");
      const provesAnns = annotations.filter(a => a.key === "proves");
      const componentLabels = uniqueList([
        moduleAnn?.value || null,
        ...capabilityLabels,
      ]);

      if (componentLabels.length === 0) continue;
      // If the file already has a @planner:story link, skip (already registered)
      if (storyAnns.length > 0) continue;

      const titleSeed = moduleAnn?.value || capabilityLabels[0];
      const notes = capabilityLabels.length > 0
        ? `Capabilities: ${capabilityLabels.join("; ")}`
        : "";

      candidates.push({
        title:           `[${titleSeed}] component — capability coverage`,
        source:          "annotation",
        annotation_refs: componentLabels,
        capability_refs: [filePath],
        proves_refs:     provesAnns.map(a => a.value).filter(Boolean),
        notes,
      });
    }
  } catch (e) {
    console.error(`  ⚠️ Annotation scan error: ${e.message} — skipping`);
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Source 2: Persona audit findings → story candidates
// ---------------------------------------------------------------------------

async function candidatesFromPersonaFindings() {
  const candidates = [];
  try {
    const runnerPath = join(skillPath, "scripts", "audit_runner.mjs");
    if (!existsSync(runnerPath)) return candidates;

    const { loadAuditConfig, loadRolePacks, buildProjectContext, runRoleAuditors, enforceMinimumPersona } =
      await import(runnerPath);

    const auditConfig = loadAuditConfig(cwd);
    if (!auditConfig) {
      console.error("  ⚠️ No audit.config.json — skipping persona findings");
      return candidates;
    }

    let packs = await loadRolePacks(auditConfig, skillPath, cwd);
    const context = await buildProjectContext(cwd, skillPath, auditConfig);
    packs = await enforceMinimumPersona(packs, context);

    if (packs.length === 0) return candidates;

    const findings = await runRoleAuditors(context, packs);

    // Extract findings that represent capability gaps (fail/warn severity → likely missing story)
    for (const f of findings) {
      if (f.severity !== "fail" && f.severity !== "warn") continue;
      const title = `[persona] ${f.analyzer}: ${f.message}`.slice(0, 120);
      candidates.push({
        title,
        source:          "persona",
        annotation_refs: [],
        capability_refs: f.location ? [f.location] : [],
        proves_refs:     [],
        notes:           f.details || "",
      });
    }
  } catch (e) {
    console.error(`  ⚠️ Persona audit error: ${e.message} — skipping`);
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Source 3: findings.md ## Story Candidates section (dialogue-driven)
// ---------------------------------------------------------------------------

function candidatesFromFindings(planDir) {
  const candidates = [];
  if (!planDir) return candidates;

  try {
    const content = readFindingsMarkdown(planDir);
    if (!content) return candidates;
    const sectionMatch = content.match(/## Story Candidates\s*\n([\s\S]+?)(?=\n## |$)/);
    if (!sectionMatch) return candidates;

    const section = sectionMatch[1];
    // Parse bullet list: "- Title (priority: high/medium/low)"
    for (const line of section.split("\n")) {
      const m = line.match(/^\s*[-*]\s+(.+?)(?:\s*\(priority:\s*(high|medium|low)\))?\s*$/i);
      if (!m) continue;
      const title = m[1].trim();
      const priority = (m[2] || "medium").toLowerCase();
      if (title) {
        candidates.push({
          title,
          source:          "dialogue",
          priority,
          annotation_refs: [],
          capability_refs: [],
          proves_refs:     [],
        });
      }
    }
  } catch { /* non-fatal */ }
  return candidates;
}

// ---------------------------------------------------------------------------
// Deduplication: skip candidates with titles matching existing stories
// ---------------------------------------------------------------------------

function normalizeTitle(t) {
  return String(t || "")
    .toLowerCase()
    .replace(/\*\*/g, "")
    .replace(/^us-\d+\s+/, "")
    .replace(/\s+[:—–]\s+.*$/, "")
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseStoryCandidate(candidate) {
  const rawTitle = String(candidate?.title || "").trim();
  let text = rawTitle.replace(/\*\*/g, "").trim();
  let requestedId = null;
  let title = text;
  let description = "";

  const idMatch = text.match(/^(US-\d+)\s+(.+)$/i);
  if (idMatch) {
    requestedId = idMatch[1].toUpperCase();
    title = idMatch[2].trim();
  }

  const colonMatch = title.match(/^(.+?)\s*:\s+(.+)$/);
  if (colonMatch) {
    title = colonMatch[1].trim();
    description = colonMatch[2].trim();
  }

  return {
    ...candidate,
    requested_id: requestedId,
    title: title || rawTitle,
    notes: uniqueList([candidate?.notes, description]).join("\n"),
  };
}

function storyMatchesCandidate(story, candidate) {
  const storyId = String(story?.id || "").trim().toUpperCase();
  const requestedId = String(candidate?.requested_id || "").trim().toUpperCase();
  if (requestedId && storyId === requestedId) return true;

  const storyTitle = normalizeTitle(story?.title || "");
  const candidateTitle = normalizeTitle(candidate?.title || "");
  if (!storyTitle || !candidateTitle) return false;
  if (storyTitle === candidateTitle) return true;
  if (storyTitle.length >= 12 && candidateTitle.length >= 12) {
    return storyTitle.includes(candidateTitle) || candidateTitle.includes(storyTitle);
  }
  return false;
}

function deduplicate(candidates, existing) {
  const accepted = [...existing];
  const deduped = [];
  for (const rawCandidate of candidates) {
    const candidate = parseStoryCandidate(rawCandidate);
    if (accepted.some((story) => storyMatchesCandidate(story, candidate))) continue;
    deduped.push(candidate);
    accepted.push({
      id: candidate.requested_id || `__candidate_${deduped.length}`,
      title: candidate.title,
    });
  }
  return deduped;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { plansDir } = getPaths(cwd, skillPath);
  // Find active plan dir (for findings.md story candidates)
  let planDir = null;
  if (existsSync(join(cwd, ".pointer"))) {
    try {
      const pointer = readFileSync(join(cwd, ".pointer"), "utf-8").trim();
      const candidate = join(plansDir, pointer);
      if (existsSync(candidate)) planDir = candidate;
    } catch { /* non-fatal */ }
  }
  // Fallback: check plans/ dir for any plan directory
  if (!planDir && existsSync(plansDir)) {
    try {
      const { readdirSync, statSync } = await import("fs");
      const entries = readdirSync(plansDir)
        .filter(e => e.startsWith("plan_"))
        .sort()
        .reverse();
      if (entries.length > 0) planDir = join(plansDir, entries[0]);
    } catch { /* non-fatal */ }
  }

  const registry = loadRegistry();
  const existing = registry.stories || [];
  const stats = { from_annotations: 0, from_personas: 0, from_dialogue: 0, added: 0, skipped_existing: 0 };

  if (!flags.json) console.log(`\n  story_registry_bootstrap — project: ${cwd}\n`);

  // Gather candidates from all sources
  const annCandidates  = await candidatesFromAnnotations();
  const persCandidates = await candidatesFromPersonaFindings();
  const dlgCandidates  = candidatesFromFindings(planDir);

  stats.from_annotations = annCandidates.length;
  stats.from_personas    = persCandidates.length;
  stats.from_dialogue    = dlgCandidates.length;

  if (!flags.json) {
    console.log(`  Sources:`);
    console.log(`    @planner: annotations → ${stats.from_annotations} candidate(s)`);
    console.log(`    Persona findings      → ${stats.from_personas} candidate(s)`);
    console.log(`    Dialogue (findings)   → ${stats.from_dialogue} candidate(s)`);
    console.log();
  }

  // Merge and deduplicate all candidates
  const allCandidates = [...annCandidates, ...persCandidates, ...dlgCandidates];
  const newCandidates = deduplicate(allCandidates, existing);
  stats.skipped_existing = allCandidates.length - newCandidates.length;

  // Assign IDs and build new story entries
  let nextIdNum = nextId(existing);
  const newStories = [];

  for (const c of newCandidates) {
    const requestedId = String(c.requested_id || "").toUpperCase();
    let storyId = requestedId && !existing.some((story) => String(story?.id || "").toUpperCase() === requestedId)
      ? requestedId
      : formatId(nextIdNum);
    const requestedNumber = parseIdNumber(storyId);
    if (requestedNumber !== null && requestedNumber >= nextIdNum) nextIdNum = requestedNumber + 1;
    else nextIdNum++;

    const story = {
      id:              storyId,
      title:           c.title,
      status:          "NOT_IMPLEMENTED",
      priority:        c.priority || "medium",
      source:          c.source,
      annotation_refs: c.annotation_refs || [],
      capability_refs: c.capability_refs || [],
      test_story_ref:  null,
    };
    if (c.proves_refs && c.proves_refs.length > 0) story.proves_refs = c.proves_refs;
    if (c.notes) story.notes = c.notes;
    newStories.push(story);
    stats.added++;
  }

  // Output
  if (flags.json) {
    emitJson({
      project:    cwd,
      dry_run:    flags.dryRun,
      existing:   existing.length,
      added:      newStories.length,
      skipped:    stats.skipped_existing,
      stats,
      new_stories: newStories,
    }, { exitCode: 0 });
  } else {
    if (newStories.length === 0) {
      console.log(`  ✅ No new stories to add — registry already covers all detected candidates`);
      console.log(`     (${existing.length} existing stories, ${stats.skipped_existing} candidates matched existing)`);
    } else {
      console.log(`  New stories (${newStories.length}):`);
      for (const s of newStories) {
        console.log(`    ${s.id}  [${s.source}] ${s.title}`);
      }
      console.log();
      if (flags.dryRun) {
        console.log(`  ℹ️  Dry run — registry not written. Remove --dry-run to apply.`);
      } else {
        console.log(`  Writing ${existing.length + newStories.length} stories to registry...`);
      }
    }
  }

  // Write registry (unless dry-run or nothing to add)
  if (!flags.dryRun && newStories.length > 0) {
    registry.stories = [...existing, ...newStories];
    registry.generated_at = new Date().toISOString();
    registry.source = "story_registry_bootstrap.mjs";

    mkdirSync(REGISTRY_DIR, { recursive: true });
    writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");

    if (!flags.json) {
      console.log(`  ✅ Registry written: ${REGISTRY_PATH}`);
      console.log(`     Total stories: ${registry.stories.length} (${existing.length} existing + ${newStories.length} new)`);
    }
  }
}

main().catch(e => {
  console.error(`ERROR: ${e.message}`);
  process.exitCode = 1;
});
