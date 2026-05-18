#!/usr/bin/env node
// test_discovery_policy_scaffold.mjs — additive scaffold suggestions for planner.discovery.json.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const plannerRoot = resolve(testDir, "..", "..", "..", "..");
const migratePath = join(plannerRoot, ".agent", "skills", "iterative-planner", "scripts", "migrate.mjs");
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

const tmp = mkdtempSync(join(tmpdir(), "planner-discovery-scaffold-"));

try {
  const quantProject = join(tmp, "ValueInvestingAI");
  const unknownProject = join(tmp, "unknown-repo");
  const guardedProject = join(tmp, "crawler-extractor-agent");
  mkdirSync(quantProject, { recursive: true });
  mkdirSync(unknownProject, { recursive: true });
  mkdirSync(guardedProject, { recursive: true });

  const preview = run([migratePath, "scaffold-discovery-policy", quantProject, "--json"], plannerRoot);
  assert(preview.ok, "scaffold-discovery-policy exits cleanly for a matched project");
  const previewJson = JSON.parse(preview.stdout);
  assert(previewJson?.matched === true, "scaffold-discovery-policy matches the quant project to a known archetype");
  assert(previewJson?.recommended_policy?.archetype === "quant", "scaffold-discovery-policy recommends the quant archetype");
  assert((previewJson?.recommended_policy?.preferred_workflows || []).includes("/sme-improvement"), "scaffold-discovery-policy recommends /sme-improvement for quant projects");
  assert((previewJson?.recommended_policy?.preferred_personas || []).includes("quant"), "scaffold-discovery-policy recommends quant personas");
  assert(previewJson?.write_status === "not_written", "scaffold-discovery-policy does not write without --write");
  assert(existsSync(join(quantProject, "planner.discovery.json")) === false, "scaffold-discovery-policy leaves planner.discovery.json absent without --write");

  const written = run([migratePath, "scaffold-discovery-policy", quantProject, "--write", "--json"], plannerRoot);
  assert(written.ok, "scaffold-discovery-policy can write a missing policy file");
  const writtenJson = JSON.parse(written.stdout);
  assert(writtenJson?.write_status === "written", "scaffold-discovery-policy reports a written scaffold");
  const writtenPolicy = JSON.parse(readFileSync(join(quantProject, "planner.discovery.json"), "utf-8"));
  assert(writtenPolicy?.archetype === "quant", "scaffold-discovery-policy writes the recommended archetype");
  assert((writtenPolicy?.preferred_workflows || []).includes("/sme-improvement"), "scaffold-discovery-policy writes the recommended workflow");

  writeFileSync(join(guardedProject, "planner.discovery.json"), JSON.stringify({
    archetype: "custom-content",
    preferred_workflows: ["/advisor"],
  }, null, 2));
  const preserved = run([migratePath, "scaffold-discovery-policy", guardedProject, "--write", "--json"], plannerRoot);
  assert(preserved.ok, "scaffold-discovery-policy exits cleanly when a host-owned policy already exists");
  const preservedJson = JSON.parse(preserved.stdout);
  assert(preservedJson?.write_status === "preserved_existing", "scaffold-discovery-policy preserves existing host-owned discovery policy files");
  const preservedPolicy = JSON.parse(readFileSync(join(guardedProject, "planner.discovery.json"), "utf-8"));
  assert(preservedPolicy?.archetype === "custom-content", "scaffold-discovery-policy does not overwrite existing discovery policy content");

  const noMatch = run([migratePath, "scaffold-discovery-policy", unknownProject, "--json"], plannerRoot);
  assert(noMatch.ok, "scaffold-discovery-policy exits cleanly for unmatched projects");
  const noMatchJson = JSON.parse(noMatch.stdout);
  assert(noMatchJson?.matched === false, "scaffold-discovery-policy reports no match for unknown projects");
  assert(noMatchJson?.write_status === "no_match", "scaffold-discovery-policy reports no_match when no deterministic scaffold exists");
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
