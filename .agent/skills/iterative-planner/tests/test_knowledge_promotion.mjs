#!/usr/bin/env node
// test_knowledge_promotion.mjs — promote-knowledge scaffolds host-owned KB overlays additively.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const plannerRoot = resolve(testDir, "..", "..", "..", "..");
const migratePath = join(plannerRoot, ".agent", "skills", "iterative-planner", "scripts", "migrate.mjs");
const currentVersion = JSON.parse(
  readFileSync(join(plannerRoot, ".agent", "skills", "iterative-planner", "config", "version.json"), "utf-8")
).version;
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

function run(args, cwd) {
  try {
    return {
      ok: true,
      stdout: execFileSync(NODE, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function seedKnowledgeProject(targetPath) {
  cpSync(join(plannerRoot, ".agent"), join(targetPath, ".agent"), { recursive: true });
  for (const name of ["CLAUDE.md", "GEMINI.md", "AGENTS.md"]) {
    const source = join(plannerRoot, name);
    if (existsSync(source)) {
      cpSync(source, join(targetPath, name));
    }
  }
  mkdirSync(join(targetPath, "plans", "knowledge"), { recursive: true });
  writeFileSync(join(targetPath, "plans", "knowledge", "mistakes.md"), `# Mistakes

## M-101: Promote migration learnings into overlays (2026-04-08)
**What happened:** Migration learnings remained narrative-only after planner-core upgrades.

**Pattern to break:** Scaffold deterministic draft overlays and review them before activation.

## M-102: Responsive proof obligations must survive migration (2026-04-08)
**What happened:** Responsive work lost its manual proof expectations during a migration.

**How to prevent:** Keep verification and evidence obligations visible during promotion.

## M-103: Registry guards should stay queryable after retro promotion (2026-04-08)
**What happened:** A repeatable planner mistake remained buried in markdown and never became searchable active-intelligence data.

**How to prevent:** Promote stable repeatable lessons into the mistake registry layer instead of leaving them prose-only.
`);
  writeFileSync(join(targetPath, "plans", "knowledge", "patterns.md"), "# Patterns\n");
  writeFileSync(join(targetPath, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");
  mkdirSync(join(targetPath, "plans", "knowledge", "retros", "cases"), { recursive: true });
  writeFileSync(join(targetPath, "plans", "knowledge", "retros", "retro_ledger.json"), JSON.stringify({
    version: 1,
    retros: [
      {
        id: "R-2026-04-08-001",
        date: "2026-04-08",
        title: "Narrative-only migration learning should stay docs-only",
        summary: "Some KB items should remain archival narrative instead of becoming runtime overlays.",
        failure_modes: ["MISSING_GATE"],
        discovered_phase: "reflect-to-validate",
        affected_surfaces: ["plans/knowledge/mistakes.md"],
        root_cause: "Not every retro should become a live runtime rule.",
        promotion_decision: "docs_only",
        kb_refs: ["plans/knowledge/mistakes.md#M-101"],
        case_file: "plans/knowledge/retros/cases/R-2026-04-08-001.md",
        status: "accepted"
      },
      {
        id: "R-2026-04-08-002",
        date: "2026-04-08",
        title: "Responsive proof expectations should become a learned obligation",
        summary: "Proof-heavy responsive work should promote into both registry and obligation overlays.",
        failure_modes: ["MISSED_TEST"],
        discovered_phase: "reflect-to-validate",
        affected_surfaces: ["plans/knowledge/mistakes.md", "verification.md"],
        root_cause: "The proof contract stayed implicit instead of becoming reusable.",
        promotion_decision: "learned_obligation",
        promotions: {
          mistake_ids: ["KB-M-102"],
          obligation_ids: ["KB-LO-M-102"],
          invariant_ids: []
        },
        kb_refs: ["plans/knowledge/mistakes.md#M-102"],
        case_file: "plans/knowledge/retros/cases/R-2026-04-08-002.md",
        status: "accepted"
      },
      {
        id: "R-2026-04-08-003",
        date: "2026-04-08",
        title: "Repeatable planner drift should become a registry guard",
        summary: "Stable repeatable planner learnings should scaffold a registry candidate even when they are not proof-heavy.",
        failure_modes: ["MISSED_GENERALIZE"],
        discovered_phase: "execute-to-reflect",
        affected_surfaces: ["plans/knowledge/mistakes.md"],
        root_cause: "A reusable planner guard stayed trapped in markdown.",
        promotion_decision: "registry_guard",
        promotions: {
          mistake_ids: ["KB-M-103"],
          obligation_ids: [],
          invariant_ids: []
        },
        kb_refs: ["plans/knowledge/mistakes.md#M-103"],
        case_file: "plans/knowledge/retros/cases/R-2026-04-08-003.md",
        status: "accepted"
      }
    ]
  }, null, 2));
  writeFileSync(join(targetPath, "plans", "knowledge", "retros", "cases", "R-2026-04-08-001.md"), "# R-2026-04-08-001\n");
  writeFileSync(join(targetPath, "plans", "knowledge", "retros", "cases", "R-2026-04-08-002.md"), "# R-2026-04-08-002\n");
  writeFileSync(join(targetPath, "plans", "knowledge", "retros", "cases", "R-2026-04-08-003.md"), "# R-2026-04-08-003\n");
  const skillPath = join(targetPath, ".agent", "skills", "iterative-planner", "SKILL.md");
  const skillContent = readFileSync(skillPath, "utf-8");
  writeFileSync(
    skillPath,
    skillContent.includes("planner_version:")
      ? skillContent.replace(/planner_version:\s*["']?\d+\.\d+\.\d+["']?/, `planner_version: "${currentVersion}"`)
      : skillContent.replace(/^---\n/, `---\nplanner_version: "${currentVersion}"\n`)
  );
}

const tmp = mkdtempSync(join(tmpdir(), "planner-knowledge-promotion-"));

try {
  const freshProject = join(tmp, "fresh-project");
  const mergeProject = join(tmp, "merge-project");
  const reviewedProject = join(tmp, "reviewed-project");
  const invalidProject = join(tmp, "invalid-project");
  for (const project of [freshProject, mergeProject, reviewedProject, invalidProject]) {
    mkdirSync(project, { recursive: true });
    seedKnowledgeProject(project);
  }

  const preview = run([migratePath, "promote-knowledge", freshProject, "--json"], plannerRoot);
  assert(preview.ok, "promote-knowledge preview exits cleanly");
  const previewJson = JSON.parse(preview.stdout);
  assert(previewJson?.source_files?.mistakes?.entry_count === 3, "promote-knowledge counts KB mistake entries");
  assert(previewJson?.source_files?.retro_ledger?.present === true, "promote-knowledge notices the structured retro ledger when it is present");
  assert(previewJson?.source_files?.retro_ledger?.accepted_count === 3, "promote-knowledge reports accepted retros from the structured archive");
  assert((previewJson?.candidates?.registry_candidates || []).length === 2, "promote-knowledge scaffolds registry candidates from retro-promoted KB mistakes");
  assert((previewJson?.candidates?.obligation_candidates || []).length === 1, "promote-knowledge classifies learned-obligation retros into proof-heavy overlay candidates");
  assert(!(previewJson?.candidates?.registry_candidates || []).some((entry) => entry.source_id === "M-101"), "promote-knowledge suppresses docs_only retro entries");
  assert((previewJson?.candidates?.registry_candidates || []).some((entry) => entry.source_id === "M-103" && entry.promotion_decision === "registry_guard"), "promote-knowledge records registry_guard retro metadata on scaffolded mistake candidates");
  assert((previewJson?.candidates?.obligation_candidates || []).some((entry) => entry.source_id === "M-102" && entry.promotion_decision === "learned_obligation"), "promote-knowledge records learned_obligation retro metadata on scaffolded obligation candidates");
  assert(previewJson?.overlays?.mistake_overrides?.write_status === "not_written", "promote-knowledge does not write mistake overlays without --write");
  assert(previewJson?.overlays?.learned_obligation_overrides?.write_status === "not_written", "promote-knowledge does not write learned-obligation overlays without --write");
  assert(existsSync(join(freshProject, "planner.mistake_overrides.json")) === false, "promote-knowledge preview leaves planner.mistake_overrides.json absent");
  assert(existsSync(join(freshProject, "planner.learned_obligations.json")) === false, "promote-knowledge preview leaves planner.learned_obligations.json absent");

  const written = run([migratePath, "promote-knowledge", freshProject, "--write", "--json"], plannerRoot);
  assert(written.ok, "promote-knowledge can write missing overlay files");
  const writtenJson = JSON.parse(written.stdout);
  assert(writtenJson?.overlays?.mistake_overrides?.write_status === "written", "promote-knowledge reports a written mistake overlay file");
  assert(writtenJson?.overlays?.learned_obligation_overrides?.write_status === "written", "promote-knowledge reports a written learned-obligation overlay file");
  const writtenMistakes = JSON.parse(readFileSync(join(freshProject, "planner.mistake_overrides.json"), "utf-8"));
  const writtenObligations = JSON.parse(readFileSync(join(freshProject, "planner.learned_obligations.json"), "utf-8"));
  assert(!(writtenMistakes?.mistakes || []).some((entry) => entry.id === "KB-M-101"), "promote-knowledge does not scaffold docs_only retro entries into the mistake overlay");
  assert((writtenMistakes?.mistakes || []).some((entry) => entry.id === "KB-M-102"), "promote-knowledge writes retro-approved mistake overlay candidates");
  assert((writtenMistakes?.mistakes || []).some((entry) => entry.id === "KB-M-103" && entry.status === "draft"), "promote-knowledge writes registry_guard retro entries into the mistake overlay");
  assert((writtenObligations?.obligations || []).some((entry) => entry.id === "KB-LO-M-102" && entry.status === "draft"), "promote-knowledge writes draft learned-obligation candidates for proof-heavy KB entries");

  writeFileSync(join(mergeProject, "planner.mistake_overrides.json"), JSON.stringify({
    version: 1,
    mistakes: [
      {
        id: "CUSTOM-M-001",
        title: "Custom host rule",
        summary: "Existing host-owned override.",
        status: "active",
      },
    ],
  }, null, 2));
  const merged = run([migratePath, "promote-knowledge", mergeProject, "--write", "--json"], plannerRoot);
  assert(merged.ok, "promote-knowledge merges additively into existing valid mistake overlays");
  const mergedJson = JSON.parse(merged.stdout);
  assert(mergedJson?.overlays?.mistake_overrides?.write_status === "merged_existing", "promote-knowledge reports merged_existing for valid host-owned overlays");
  const mergedMistakes = JSON.parse(readFileSync(join(mergeProject, "planner.mistake_overrides.json"), "utf-8"));
  assert((mergedMistakes?.mistakes || []).some((entry) => entry.id === "CUSTOM-M-001"), "promote-knowledge preserves existing host-owned mistake entries");
  assert((mergedMistakes?.mistakes || []).some((entry) => entry.id === "KB-M-102"), "promote-knowledge appends retro-approved KB mistake entries additively");
  assert((mergedMistakes?.mistakes || []).some((entry) => entry.id === "KB-M-103"), "promote-knowledge appends registry_guard KB mistake entries additively");

  writeFileSync(join(reviewedProject, "plans", "knowledge", "draft_candidates.review.json"), JSON.stringify({
    version: 1,
    reviewed_candidates: [
      {
        id: "DC-001",
        kind: "mistake",
        title: "Reviewed planner ripple guard",
        summary: "A reviewed draft candidate should scaffold a mistake override without becoming runtime truth.",
        source_refs: ["plans/knowledge/mistakes.md#M-103"],
        linked_ids: ["retro:R-2026-04-08-003"],
        matched_by: ["outer_gap_check"],
        score: 41,
        trust_level: "draft",
        blocking_capable: true,
        review_status: "approved",
        promotion_target: "mistake_overrides",
        overlay_entry: {
          id: "HOST-M-REVIEW-001",
          title: "Reviewed draft planner guard",
          summary: "Reviewed candidates should land in the host overlay as draft entries only.",
          status: "active"
        }
      },
      {
        id: "DC-002",
        kind: "learned_obligation",
        title: "Reviewed responsive proof follow-up",
        summary: "A reviewed draft candidate should scaffold a learned obligation as an inert draft entry.",
        source_refs: ["plans/knowledge/mistakes.md#M-102"],
        linked_ids: ["mistake:KB-M-102"],
        matched_by: ["outer_gap_check"],
        score: 38,
        trust_level: "draft",
        blocking_capable: false,
        review_status: "approved",
        promotion_target: "learned_obligation_overrides",
        overlay_entry: {
          id: "HOST-LO-REVIEW-001",
          subject_id: "draft:reviewed_responsive_proof",
          verification_mode: "manual_review",
          status: "active"
        }
      }
    ]
  }, null, 2));
  const reviewedPreview = run([migratePath, "promote-knowledge", reviewedProject, "--json"], plannerRoot);
  assert(reviewedPreview.ok, "promote-knowledge preview ingests the reviewed draft-candidate surface");
  const reviewedPreviewJson = JSON.parse(reviewedPreview.stdout);
  assert(reviewedPreviewJson?.review_surface?.present === true, "promote-knowledge reports the reviewed draft-candidate surface when present");
  assert(reviewedPreviewJson?.review_surface?.approved_count === 2, "promote-knowledge counts approved reviewed draft candidates");
  assert(reviewedPreviewJson?.review_surface?.promotable_count === 2, "promote-knowledge reports promotable reviewed draft candidates");
  assert((reviewedPreviewJson?.candidates?.reviewed_draft_candidates || []).length === 2, "promote-knowledge surfaces reviewed draft candidates in the report");
  assert((reviewedPreviewJson?.candidates?.mistake_overlay_candidates || []).some((entry) => entry.id === "HOST-M-REVIEW-001"), "promote-knowledge folds approved reviewed draft mistakes into the additive overlay candidates");
  assert((reviewedPreviewJson?.candidates?.learned_obligation_overlay_candidates || []).some((entry) => entry.id === "HOST-LO-REVIEW-001"), "promote-knowledge folds approved reviewed draft obligations into the additive overlay candidates");
  assert((reviewedPreviewJson?.recommended_command || "").includes("--draft-candidates"), "promote-knowledge advertises the reviewed draft-candidate flag in the recommended command");

  const reviewedWritten = run([migratePath, "promote-knowledge", reviewedProject, "--write", "--json"], plannerRoot);
  assert(reviewedWritten.ok, "promote-knowledge writes approved reviewed draft candidates into host-owned overlays");
  const reviewedWrittenMistakes = JSON.parse(readFileSync(join(reviewedProject, "planner.mistake_overrides.json"), "utf-8"));
  const reviewedWrittenObligations = JSON.parse(readFileSync(join(reviewedProject, "planner.learned_obligations.json"), "utf-8"));
  assert((reviewedWrittenMistakes?.mistakes || []).some((entry) => entry.id === "HOST-M-REVIEW-001" && entry.status === "draft"), "promote-knowledge forces reviewed draft mistake candidates to stay draft in the host overlay");
  assert((reviewedWrittenObligations?.obligations || []).some((entry) => entry.id === "HOST-LO-REVIEW-001" && entry.status === "draft"), "promote-knowledge forces reviewed draft learned obligations to stay draft in the host overlay");

  writeFileSync(join(invalidProject, "planner.mistake_overrides.json"), "{invalid json\n");
  writeFileSync(join(invalidProject, "planner.learned_obligations.json"), "{invalid json\n");
  const blocked = run([migratePath, "promote-knowledge", invalidProject, "--write", "--json"], plannerRoot);
  assert(blocked.ok, "promote-knowledge still exits cleanly when existing overlays are invalid");
  const blockedJson = JSON.parse(blocked.stdout);
  assert(blockedJson?.overlays?.mistake_overrides?.write_status === "blocked_invalid_existing", "promote-knowledge refuses to overwrite invalid existing mistake overlays");
  assert(blockedJson?.overlays?.learned_obligation_overrides?.write_status === "blocked_invalid_existing", "promote-knowledge refuses to overwrite invalid existing learned-obligation overlays");
  assert(readFileSync(join(invalidProject, "planner.mistake_overrides.json"), "utf-8").includes("{invalid json"), "promote-knowledge preserves invalid mistake overlay content for manual repair");
  assert(readFileSync(join(invalidProject, "planner.learned_obligations.json"), "utf-8").includes("{invalid json"), "promote-knowledge preserves invalid learned-obligation overlay content for manual repair");

  const collisionProject = join(tmp, "collision-project");
  mkdirSync(collisionProject, { recursive: true });
  seedKnowledgeProject(collisionProject);
  writeFileSync(join(collisionProject, "planner.mistake_overrides.json"), JSON.stringify({
    version: 1,
    mistakes: [
      {
        id: "M-UI-001",
        title: "Colliding override",
        summary: "Collides with shipped registry id.",
        status: "active",
      },
    ],
  }, null, 2));
  writeFileSync(join(collisionProject, "planner.learned_obligations.json"), JSON.stringify({
    version: 1,
    obligations: [
      {
        id: "responsive_ui_mobile",
        subject_id: "draft:collision_subject",
        verification_mode: "manual_review",
        status: "active",
      },
    ],
  }, null, 2));
  const collision = run([migratePath, "promote-knowledge", collisionProject, "--write", "--json"], plannerRoot);
  assert(collision.ok, "promote-knowledge still exits cleanly when existing overlays are semantically invalid");
  const collisionJson = JSON.parse(collision.stdout);
  assert(collisionJson?.overlays?.mistake_overrides?.write_status === "blocked_invalid_existing", "promote-knowledge blocks colliding mistake overlays instead of merging");
  assert(collisionJson?.overlays?.mistake_overrides?.error === "duplicate_overlay_id", "promote-knowledge surfaces duplicate_overlay_id for colliding mistake overlays");
  assert(collisionJson?.overlays?.learned_obligation_overrides?.write_status === "blocked_invalid_existing", "promote-knowledge blocks colliding learned-obligation overlays instead of merging");
  assert(collisionJson?.overlays?.learned_obligation_overrides?.error === "duplicate_overlay_id", "promote-knowledge surfaces duplicate_overlay_id for colliding learned-obligation overlays");
  const collisionMistakes = JSON.parse(readFileSync(join(collisionProject, "planner.mistake_overrides.json"), "utf-8"));
  const collisionObligations = JSON.parse(readFileSync(join(collisionProject, "planner.learned_obligations.json"), "utf-8"));
  assert((collisionMistakes?.mistakes || []).length === 1, "promote-knowledge preserves colliding mistake overlay content without merging");
  assert((collisionObligations?.obligations || []).length === 1, "promote-knowledge preserves colliding learned-obligation overlay content without merging");
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
