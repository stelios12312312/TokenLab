#!/usr/bin/env node
// test_episode_source_harvest.mjs - Direct-local episode source harvest contracts.

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverProjectRoots,
  harvestEpisodeSources,
} from "../scripts/lib/episode_source_harvest.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const cli = join(skillDir, "scripts", "episode_source_harvest.mjs");
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
  return mkdtempSync(join(tmpdir(), `episode-source-${name}-`));
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

console.log("\nEpisode Source Harvest\n");

{
  const root = tmp("main");
  try {
    const project = join(root, "projects", "quant-case");
    const sibling = join(root, "sibling");
    mkdirSync(join(project, ".git"), { recursive: true });
    touch(join(project, "AGENTS.md"), "# Agent instructions\n");
    touch(join(project, "plans", "plan_2026-01-01_case", "decisions.md"), [
      "Aha: the autocode loop missed leakage in the temporal split.",
      "SECRET_TOKEN_SHOULD_NOT_APPEAR",
    ].join("\n"));
    touch(join(project, "plans", "knowledge", "retros", "case.md"), "Root cause: false-green planner gate drift blocked verification.");
    touch(join(project, "reports", "quant", "backtest_report.md"), "Calibration and OOS holdout report; no alpha claim.");
    touch(join(project, "node_modules", "ignored", "plans", "decisions.md"), "leakage should be ignored\n");
    touch(join(sibling, "keep.txt"), "do not touch\n");

    const before = listAllFiles(root);
    const roots = discoverProjectRoots([join(root, "projects")], { maxDepth: 3 });
    const report = harvestEpisodeSources({
      scanRoots: [join(root, "projects")],
      maxDepth: 3,
      artifactDepth: 5,
      candidateLimit: 10,
    });
    const after = listAllFiles(root);

    assert(roots.roots.includes(project), "project marker discovery finds fixture root");
    assert(report.ok === true, "harvest returns ok");
    assert(report.summary.project_count === 1, "one project is reported");
    assert(report.summary.candidate_count >= 3, "candidate artifacts are reported");
    assert(report.claim_boundary.quant_result_claim === false, "claim boundary forbids quant result claim");
    assert(report.claim_boundary.source_excerpt_emitted === false, "claim boundary forbids source excerpts");
    assert(report.projects[0].candidates.some((c) => c.signal_families.includes("quant_boundary")), "quant boundary signal is detected");
    assert(report.projects[0].candidates.some((c) => c.signal_families.includes("autocode_loop")), "autocode loop signal is detected");
    assert(!JSON.stringify(report).includes("SECRET_TOKEN_SHOULD_NOT_APPEAR"), "source contents are not emitted");
    assert(JSON.stringify(before) === JSON.stringify(after), "harvest does not write into scanned roots");

    const cliResult = runCli(["--scan-root", join(root, "projects"), "--max-depth", "3", "--artifact-depth", "5", "--candidate-limit", "10", "--json"], root);
    assert(cliResult.ok === true, "CLI exits cleanly for fixture root");
    assert(cliResult.parsed.summary.project_count === 1, "CLI JSON preserves project count");
    assert(cliResult.parsed.projects[0].candidates[0].score >= cliResult.parsed.projects[0].candidates.at(-1).score, "CLI candidates are score sorted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = tmp("missing");
  try {
    const report = harvestEpisodeSources({ scanRoots: [join(root, "missing")], maxDepth: 1 });
    assert(report.summary.project_count === 0, "missing scan root reports zero projects");
    assert(report.warnings.length >= 1, "missing scan root records a warning");
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
