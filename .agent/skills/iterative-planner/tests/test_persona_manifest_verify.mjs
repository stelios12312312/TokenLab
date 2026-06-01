#!/usr/bin/env node
// test_persona_manifest_verify.mjs — six drift scenarios for the persona
// manifest verifier (T-INTAKE-3B20A6BB / US-085).
//
// Each scenario builds a tmpdir fixture, copies a minimal planner shell into
// it, rebaselines or hand-writes a manifest, then invokes the verifier and
// asserts the expected status / error code(s). No mocking — the real script
// is exercised via execFileSync.

import { execFileSync } from "child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = dirname(__filename);
const SKILL_DIR = dirname(TEST_DIR);                       // .agent/skills/iterative-planner
const SCRIPT_DIR = join(SKILL_DIR, "scripts");
const VERIFIER = join(SCRIPT_DIR, "persona_manifest_verify.mjs");
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

function setupFixture(label) {
  const tmp = mkdtempSync(join(tmpdir(), `persona-manifest-${label}-`));
  // Install a copy of the planner skill into the fixture so the verifier
  // resolves PACKS_DIR / OBLIGATIONS_PATH / MANIFEST_PATH relative to the
  // fixture rather than the real repo. The script uses dirname(__filename)
  // to find its skill root, so we run the COPIED verifier from the fixture.
  const srcSkill = SKILL_DIR;
  const dstSkill = join(tmp, ".agent", "skills", "iterative-planner");
  mkdirSync(dirname(dstSkill), { recursive: true });
  cpSync(srcSkill, dstSkill, { recursive: true });
  // Drop a minimal root CLAUDE/GEMINI/AGENTS that satisfies byte-identical.
  const rootContent = "# Test fixture root instructions\n";
  for (const name of ["CLAUDE.md", "GEMINI.md", "AGENTS.md"]) {
    writeFileSync(join(tmp, name), rootContent);
  }
  // Minimal audit.config.json with all four required seed roles. Tests that
  // need to remove a seed role mutate it after setup.
  writeFileSync(
    join(tmp, "audit.config.json"),
    JSON.stringify(
      { roles: ["core", "assumptions_challenger", "wiring_auditor", "config_integrity", "traceability"] },
      null, 2,
    ),
  );
  return { tmp, verifier: join(dstSkill, "scripts", "persona_manifest_verify.mjs") };
}

function teardown(tmp) {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

function rebaseline(verifier, cwd) {
  // F-003 closure: rebaseline is dry-run without --confirm. Tests run in
  // tmpdirs that are not git repos, so the dirty-tree guard is a no-op,
  // but --allow-uncommitted makes the intent explicit.
  execFileSync(NODE, [verifier, "rebaseline", "--confirm", "--allow-uncommitted"], { cwd, encoding: "utf-8" });
}

// Robust JSON extraction: the rebaseline subcommand prints a human-readable
// diff before the JSON object. We scan from the first `{` at the start of a
// line to end-of-output and JSON.parse the substring.
function extractJson(text) {
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => l === "{");
  if (idx === -1) return null;
  return JSON.parse(lines.slice(idx).join("\n").trim());
}

function runVerify(verifier, cwd, args = []) {
  try {
    const stdout = execFileSync(NODE, [verifier, "verify", "--json", ...args], {
      cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    });
    return { exitCode: 0, parsed: tryParse(stdout), stdout };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      parsed: tryParse(err.stdout || ""),
      stdout: err.stdout || "",
      stderr: err.stderr || "",
    };
  }
}

function tryParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function hasError(parsed, code) {
  return Array.isArray(parsed?.errors) && parsed.errors.some(e => e.code === code);
}

console.log("\nPersona Manifest Verifier — six drift scenarios\n");

assert(existsSync(VERIFIER), "persona_manifest_verify.mjs exists");

// ── Scenario 1: PASS on freshly-rebaselined manifest ───────────────────────
{
  const { tmp, verifier } = setupFixture("pass");
  try {
    rebaseline(verifier, tmp);
    const result = runVerify(verifier, tmp);
    assert(result.parsed?.status === "PASS", "freshly-rebaselined manifest passes verify");
    assert(result.exitCode === 0, "freshly-rebaselined manifest exit 0");
  } finally { teardown(tmp); }
}

// ── Scenario 2: FAIL on missing pack directory ─────────────────────────────
{
  const { tmp, verifier } = setupFixture("missing-pack");
  try {
    rebaseline(verifier, tmp);
    rmSync(join(tmp, ".agent/skills/iterative-planner/packs/quant"), { recursive: true, force: true });
    const result = runVerify(verifier, tmp, ["--strict"]);
    assert(result.parsed?.status === "FAIL", "missing pack directory fails verify");
    assert(hasError(result.parsed, "persona_pack_missing"), "emits persona_pack_missing");
    assert(result.exitCode === 1, "missing pack directory exits 1 in --strict");
  } finally { teardown(tmp); }
}

// ── Scenario 3: FAIL on mutated pack file (hash drift) ─────────────────────
{
  const { tmp, verifier } = setupFixture("hash-drift");
  try {
    rebaseline(verifier, tmp);
    const idx = join(tmp, ".agent/skills/iterative-planner/packs/quant/index.mjs");
    writeFileSync(idx, readFileSync(idx, "utf-8") + "\n// mutation\n");
    const result = runVerify(verifier, tmp, ["--strict"]);
    assert(result.parsed?.status === "FAIL", "mutated pack file fails verify");
    assert(hasError(result.parsed, "persona_pack_hash_drift"), "emits persona_pack_hash_drift");
    assert(result.exitCode === 1, "mutated pack file exits 1 in --strict");
  } finally { teardown(tmp); }
}

// ── Scenario 4: FAIL on audit.config.json missing a required seed role ─────
//
// persona_adapt scan against a bare fixture returns no domain profiles (no
// src/, no plans/) so recommended_seed_roles is empty. We rebaseline first
// to populate pack hashes, then hand-mutate the manifest to record an
// explicit required seed role, then remove that role from audit.config.json.
// This isolates the seed-role check from persona_adapt's domain inference.
{
  const { tmp, verifier } = setupFixture("missing-seed");
  try {
    rebaseline(verifier, tmp);
    const manifestPath = join(tmp, ".agent/skills/iterative-planner/config/persona_manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    manifest.recommended_seed_roles = ["config_integrity"];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const audit = JSON.parse(readFileSync(join(tmp, "audit.config.json"), "utf-8"));
    audit.roles = audit.roles.filter(r => r !== "config_integrity");
    writeFileSync(join(tmp, "audit.config.json"), JSON.stringify(audit, null, 2));
    const result = runVerify(verifier, tmp, ["--strict"]);
    assert(result.parsed?.status === "FAIL", "missing seed role fails verify");
    assert(hasError(result.parsed, "persona_seed_role_missing"), "emits persona_seed_role_missing");
    assert(result.exitCode === 1, "missing seed role exits 1 in --strict");
  } finally { teardown(tmp); }
}

// ── Scenario 5: FAIL on CLAUDE.md vs GEMINI.md divergence ──────────────────
{
  const { tmp, verifier } = setupFixture("parity-drift");
  try {
    rebaseline(verifier, tmp);
    writeFileSync(join(tmp, "GEMINI.md"), "# Drifted content\n");
    const result = runVerify(verifier, tmp, ["--strict"]);
    assert(result.parsed?.status === "FAIL", "GEMINI.md divergence fails verify");
    assert(hasError(result.parsed, "root_instruction_parity_drift"), "emits root_instruction_parity_drift");
    assert(result.exitCode === 1, "GEMINI.md divergence exits 1 in --strict");
  } finally { teardown(tmp); }
}

// ── Scenario 6: PASS when packs AND manifest are rebaselined together ──────
{
  const { tmp, verifier } = setupFixture("rebaseline-together");
  try {
    rebaseline(verifier, tmp);
    const idx = join(tmp, ".agent/skills/iterative-planner/packs/quant/index.mjs");
    writeFileSync(idx, readFileSync(idx, "utf-8") + "\n// legitimate edit\n");
    // The cross-file PR check is enforced in CI by diffing against the base
    // ref. Locally we simulate that the operator re-baselined after the edit.
    rebaseline(verifier, tmp);
    const result = runVerify(verifier, tmp, ["--strict"]);
    assert(result.parsed?.status === "PASS", "packs+manifest rebaselined together passes verify");
    assert(result.exitCode === 0, "packs+manifest rebaselined together exit 0");
  } finally { teardown(tmp); }
}

// ── Scenario 7: F-003 rebaseline guard ─────────────────────────────────────
// Dry-run mode: rebaseline without --confirm prints diff but does not write.
{
  const { tmp, verifier } = setupFixture("rebaseline-dry-run");
  try {
    // First, create an initial manifest via --confirm.
    execFileSync(NODE, [verifier, "rebaseline", "--confirm", "--allow-uncommitted"], { cwd: tmp, encoding: "utf-8" });
    const manifestPath = join(tmp, ".agent/skills/iterative-planner/config/persona_manifest.json");
    const beforeMtimeMs = statSync(manifestPath).mtimeMs;
    // Edit a pack file so the manifest WOULD change on rebaseline.
    const idx = join(tmp, ".agent/skills/iterative-planner/packs/quant/index.mjs");
    writeFileSync(idx, readFileSync(idx, "utf-8") + "\n// edit for dry-run test\n");
    // Sleep 10ms to make mtime differences detectable.
    execFileSync("sleep", ["0.1"]);
    // Rebaseline WITHOUT --confirm — should not touch the file.
    const out = execFileSync(NODE, [verifier, "rebaseline", "--json"], { cwd: tmp, encoding: "utf-8" });
    const parsed = extractJson(out);
    const afterMtimeMs = statSync(manifestPath).mtimeMs;
    assert(parsed?.status === "DRY_RUN", "dry-run mode reports DRY_RUN status");
    assert(parsed?.written === false, "dry-run mode does not write");
    assert(afterMtimeMs === beforeMtimeMs, "manifest file mtime unchanged after dry-run rebaseline");
  } finally { teardown(tmp); }
}

// --confirm on a clean tree writes.
{
  const { tmp, verifier } = setupFixture("rebaseline-confirm");
  try {
    execFileSync(NODE, [verifier, "rebaseline", "--confirm", "--allow-uncommitted"], { cwd: tmp, encoding: "utf-8" });
    const idx = join(tmp, ".agent/skills/iterative-planner/packs/quant/index.mjs");
    writeFileSync(idx, readFileSync(idx, "utf-8") + "\n// edit for confirm test\n");
    const out = execFileSync(NODE, [verifier, "rebaseline", "--confirm", "--allow-uncommitted", "--json"], { cwd: tmp, encoding: "utf-8" });
    const parsed = extractJson(out);
    assert(parsed?.status === "REBASELINED", "confirm + allow-uncommitted writes the manifest");
    assert(parsed?.written === true, "confirm + allow-uncommitted reports written=true");
  } finally { teardown(tmp); }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
