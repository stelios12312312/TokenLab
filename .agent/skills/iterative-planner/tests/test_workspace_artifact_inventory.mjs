#!/usr/bin/env node
// test_workspace_artifact_inventory.mjs - Read-only workspace inventory contracts.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  deriveHomeRemapCandidate,
  inventoryWorkspaceArtifacts,
  loadProjectRegistry,
} from "../scripts/lib/workspace_artifact_inventory.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const cli = join(skillDir, "scripts", "workspace_artifact_inventory.mjs");
const NODE = process.execPath;

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  FAIL: ${label}`);
  }
}

function tmp(name) {
  return mkdtempSync(join(tmpdir(), `workspace-inventory-${name}-`));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function touch(path, content = "") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function listAllFiles(root) {
  const out = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else out.push(abs.replace(root, ""));
    }
  }
  visit(root);
  return out.sort();
}

function runCli(args, cwd) {
  try {
    const stdout = execFileSync(NODE, [cli, ...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, stdout, parsed: JSON.parse(stdout) };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || ""),
      parsed: (() => {
        try { return JSON.parse(String(error.stdout || "")); } catch { return null; }
      })(),
    };
  }
}

console.log("\nWorkspace Artifact Inventory\n");

{
  const root = tmp("main");
  try {
    const registryPath = join(root, "registry.json");
    const present = join(root, "present-project");
    const currentHome = join(root, "current-home");
    const oldProject = "/Users/old/workspaces/remapped-project";
    const remapProject = join(currentHome, "workspaces", "remapped-project");
    const staleProject = join(root, "missing-project");

    mkdirSync(present, { recursive: true });
    mkdirSync(remapProject, { recursive: true });
    touch(join(present, "plans", "plan_2026-01-01_demo", "decisions.md"), "decision");
    touch(join(present, "plans", "knowledge", "mistakes.md"), "mistake");
    touch(join(present, "reports", "ive", "report.json"), "{}");
    touch(join(present, ".codex", "transcripts", "session.jsonl"), "{}\n");
    touch(join(root, "sibling", "keep.txt"), "do not touch");

    writeJson(registryPath, {
      projects: [
        { path: present, type: "standard" },
        { path: oldProject, type: "standard" },
        { path: staleProject, type: "standard" },
        { path: "relative/path", type: "standard" },
      ],
      scan_roots: ["/Users/old"],
      source_project_path: present,
    });

    const before = listAllFiles(root);
    const report = inventoryWorkspaceArtifacts({
      cwd: root,
      registryPath,
      currentHome,
      maxDepth: 5,
    });
    const after = listAllFiles(root);

    assert(report.ok === true, "valid registry returns ok");
    assert(report.summary.total_entries === 4, "all registry entries are reported");
    assert(report.summary.present_roots === 1, "present root is counted once");
    assert(report.summary.stale_paths === 2, "missing absolute roots are stale_path");
    assert(report.summary.invalid_paths === 1, "relative path is invalid_path");
    assert(report.summary.remap_candidates_existing === 1, "existing home-prefix remap candidate is surfaced");
    assert(report.entries[1].resolution_status === "stale_path", "old-home missing root remains stale_path");
    assert(report.entries[1].candidate_home_remaps[0].path === remapProject, "remap candidate path is current-home equivalent");
    assert(report.entries[0].artifact_counts.decision_logs >= 1, "decision logs are counted by path shape");
    assert(report.entries[0].artifact_counts.knowledge_files >= 1, "knowledge files are counted by path shape");
    assert(report.entries[0].artifact_counts.reports >= 1, "reports are counted by path shape");
    assert(report.entries[0].artifact_counts.transcript_like_files >= 1, "transcript-like files are counted by path shape");
    assert(report.claim_boundary.quant_result_claim === false, "report explicitly carries no quant result claim");
    assert(!JSON.stringify(report).includes("do not touch"), "inventory does not read arbitrary file contents");
    assert(JSON.stringify(before) === JSON.stringify(after), "inventory does not write into sibling roots");

    const cliResult = runCli(["--json", "--registry", registryPath, "--root", currentHome, "--max-depth", "5"], root);
    assert(cliResult.ok === true, "CLI exits cleanly for valid registry");
    assert(cliResult.parsed.summary.stale_paths === 2, "CLI JSON preserves stale_path count");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = tmp("invalid");
  try {
    const registryPath = join(root, "bad.json");
    writeFileSync(registryPath, "{ bad json", "utf-8");
    const loaded = loadProjectRegistry(registryPath);
    assert(loaded.ok === false && loaded.status === "invalid_json", "malformed registry is structured invalid_json");
    const cliResult = runCli(["--json", "--registry", registryPath], root);
    assert(cliResult.ok === false, "CLI exits non-zero for malformed registry");
    assert(cliResult.parsed.registry.status === "invalid_json", "CLI emits structured malformed-registry JSON");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = tmp("remap");
  try {
    const currentHome = join(root, "home");
    const candidate = join(currentHome, "Dropbox", "Project");
    mkdirSync(candidate, { recursive: true });
    const remap = deriveHomeRemapCandidate("/Users/old/Dropbox/Project", { currentHome });
    assert(remap?.path === candidate, "home remap preserves path suffix");
    assert(remap?.exists === true, "home remap records candidate existence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Failures:");
  for (const failure of failures) console.log(`- ${failure}`);
  process.exitCode = 1;
}
