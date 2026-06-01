#!/usr/bin/env node
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import {
  ROOT_INSTRUCTION_TARGETS,
  buildManagedRootInstructionSnapshot,
  collectCanonicalRootInstructionSections,
  renderRootInstructionTarget,
  rootInstructionPortabilityMatrix,
  rootInstructionParityStatus,
  rootInstructionSnapshotMatchesCanonical,
} from "../scripts/lib/root_instruction_renderer.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "../../..");
const migratePath = join(skillDir, "scripts/migrate.mjs");
const templatePath = join(skillDir, "references/CLAUDE.template.md");
const NODE = process.execPath;

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL: ${label}`);
  }
}

function cleanup(path) {
  try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort */ }
}

function createFixtureProject(name) {
  const tmp = mkdtempSync(join(tmpdir(), `planner-root-renderer-${name}-`));
  const targetRefs = join(tmp, ".agent/skills/iterative-planner/references");
  mkdirSync(targetRefs, { recursive: true });
  writeFileSync(join(targetRefs, "CLAUDE.template.md"), readFileSync(templatePath, "utf-8"));
  return tmp;
}

function run(command, cwd) {
  try {
    return {
      ok: true,
      stdout: execSync(command, { cwd, encoding: "utf-8", timeout: 30000, stdio: "pipe" }),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      status: error.status,
    };
  }
}

const templateContent = readFileSync(templatePath, "utf-8");
const canonicalSections = collectCanonicalRootInstructionSections(templateContent);
const staleSections = canonicalSections.map((section) => section.replace("notify-user", "notify-user-old"));

console.log("\nRoot Instruction Renderer Parity Tests\n");

{
  const matrix = rootInstructionPortabilityMatrix();
  const agents = new Set(matrix.flatMap((entry) => entry.agents));
  for (const expected of ["Claude", "Gemini", "Antigravity", "Cursor", "VS Code", "Codex", "AGENTS-style"]) {
    assert(agents.has(expected), `portability matrix includes ${expected}`);
  }
  for (const requiredPath of ["CLAUDE.md", "GEMINI.md", "AGENTS.md"]) {
    const entry = matrix.find((target) => target.path === requiredPath);
    assert(entry?.default_created === true, `${requiredPath} is a default managed root target`);
  }
  for (const optionalPath of [".cursor/rules/iterative-planner.mdc", ".github/copilot-instructions.md"]) {
    const entry = matrix.find((target) => target.path === optionalPath);
    assert(entry?.default_created === false, `${optionalPath} remains opt-in`);
    assert(
      entry?.managed_when_present === "refreshed_only_when_existing_or_marked_planner_managed",
      `${optionalPath} preserves host-owned files unless already planner-managed`
    );
  }
  const codex = matrix.find((target) => target.id === "codex_agents");
  assert(codex?.trace_support?.status === "not_applicable", "Codex trace support is explicitly not applicable");
  assert(
    codex?.trace_support?.gate_behavior === "Codex sessions record a clean trace-audit skip",
    "Codex trace behavior is a clean gate skip, not unsupported-warning drift"
  );
  assert(matrix.every((entry) => entry.host_owned_policy.includes("outside the managed snapshot")), "matrix records host-owned preservation policy for every target");
}

{
  const geminiTarget = ROOT_INSTRUCTION_TARGETS.find((target) => target.path === "GEMINI.md");
  const staleGemini = [
    "# Gemini host wrapper",
    "",
    "Gemini-only host note.",
    "",
    buildManagedRootInstructionSnapshot(staleSections),
    "",
    "Gemini footer stays.",
  ].join("\n");
  const rendered = renderRootInstructionTarget({
    target: geminiTarget,
    exists: true,
    content: staleGemini,
    templateContent,
    canonicalSections,
  });
  assert(rendered.changed, "renderer refreshes a stale managed snapshot");
  assert(rendered.content.includes("Gemini-only host note."), "renderer preserves host-owned content before the snapshot");
  assert(rendered.content.includes("Gemini footer stays."), "renderer preserves host-owned content after the snapshot");
  assert(rootInstructionSnapshotMatchesCanonical(rendered.content, canonicalSections), "renderer output contains the canonical managed snapshot");
}

{
  const vscodeTarget = ROOT_INSTRUCTION_TARGETS.find((target) => target.path === ".github/copilot-instructions.md");
  const custom = "# VS Code project instructions\n\nKeep this host-owned file untouched.\n";
  const rendered = renderRootInstructionTarget({
    target: vscodeTarget,
    exists: true,
    content: custom,
    templateContent,
    canonicalSections,
  });
  assert(rendered.status === "skipped_custom", "custom optional VS Code file without a managed marker is not adopted");
  assert(rendered.content === custom, "custom optional VS Code file content is preserved exactly");
}

{
  const agentsTarget = ROOT_INSTRUCTION_TARGETS.find((target) => target.path === "AGENTS.md");
  const staleAgents = `# Project Instructions - Iterative Planner\n\n${buildManagedRootInstructionSnapshot(staleSections)}\n`;
  assert(
    rootInstructionParityStatus({
      target: agentsTarget,
      exists: true,
      content: staleAgents,
      canonicalSections,
    }) === "stale_snapshot",
    "parity status detects stale generated managed snapshots"
  );
}

{
  const tmp = createFixtureProject("sync");
  try {
    const staleSnapshot = buildManagedRootInstructionSnapshot(staleSections);
    writeFileSync(join(tmp, "CLAUDE.md"), [
      "# Project Instructions - Iterative Planner",
      "",
      "CLAUDE PRIVATE HOST NOTE - must not propagate.",
      "",
      staleSnapshot,
    ].join("\n"));
    writeFileSync(join(tmp, "GEMINI.md"), [
      "# Gemini host wrapper",
      "",
      "GEMINI PRIVATE HOST NOTE - must stay.",
      "",
      staleSnapshot,
    ].join("\n"));

    const result = run(`${NODE} "${migratePath}" sync-instructions "${tmp}"`, repoRoot);
    assert(result.ok, "migrate sync-instructions exits cleanly");
    const gemini = readFileSync(join(tmp, "GEMINI.md"), "utf-8");
    const agents = readFileSync(join(tmp, "AGENTS.md"), "utf-8");
    assert(gemini.includes("GEMINI PRIVATE HOST NOTE - must stay."), "sync preserves target-owned Gemini content");
    assert(!gemini.includes("CLAUDE PRIVATE HOST NOTE - must not propagate."), "sync does not propagate Claude-only host content into Gemini");
    assert(!agents.includes("CLAUDE PRIVATE HOST NOTE - must not propagate."), "sync creates AGENTS from the managed template rather than Claude host content");
    assert(rootInstructionSnapshotMatchesCanonical(gemini, canonicalSections), "sync refreshes Gemini to the canonical snapshot");
    assert(rootInstructionSnapshotMatchesCanonical(agents, canonicalSections), "sync creates AGENTS with the canonical snapshot");
  } finally {
    cleanup(tmp);
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log(`  - ${failure}`);
}
process.exit(failed > 0 ? 1 : 0);
