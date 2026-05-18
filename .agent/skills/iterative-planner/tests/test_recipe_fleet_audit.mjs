#!/usr/bin/env node
// test_recipe_fleet_audit.mjs — Fixture proof for read-only recipe fleet audit.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const scriptDir = resolve(testDir, "..", "scripts");
const plannerCliPath = join(scriptDir, "planner.mjs");
const discoveryCliPath = join(scriptDir, "recipe_discovery.mjs");
const fixtureDir = join(testDir, "fixtures", "recipe_fleet");
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

function run(args, cwd = repoRoot) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(NODE, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          CODEX_THREAD_ID: "",
          _PLANNER_PLAN_TARGET: "",
        },
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? 1,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const raw = String(text || "");
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `recipe-fleet-${name}-`));
}

function snapshotFiles(root) {
  const snapshot = new Map();
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      snapshot.set(path.slice(root.length + 1), {
        content: readFileSync(path, "utf-8"),
        mtimeMs: statSync(path).mtimeMs,
      });
    }
  }
  walk(root);
  return snapshot;
}

function assertSnapshotUnchanged(before, root, label) {
  let changed = false;
  for (const [relativePath, entry] of before.entries()) {
    const path = join(root, relativePath);
    if (!existsSync(path)) {
      changed = true;
      break;
    }
    const content = readFileSync(path, "utf-8");
    const mtimeMs = statSync(path).mtimeMs;
    if (content !== entry.content || mtimeMs !== entry.mtimeMs) {
      changed = true;
      break;
    }
  }
  assert(!changed, label);
}

function auditFixture() {
  const result = run([plannerCliPath, "recipe", "fleet", "audit", "--config", join(fixtureDir, "config.yaml"), "--json"]);
  assert(result.ok, "planner recipe fleet audit exits cleanly");
  const audit = parseJson(result.stdout);
  assert(!!audit, "planner recipe fleet audit emits JSON");
  assert(audit?.read_only === true, "fleet audit declares read_only");
  assert(audit?.summary?.project_count === 4, "fleet audit reports project count");
  assert(audit?.summary?.recipe_count === 3, "fleet audit reports recipe count");
  assert(audit?.summary?.legacy_count === 1, "fleet audit counts legacy recipes");
  assert(audit?.projects?.some((project) => project.name === "empty_project" && project.adoption_status === "configured_empty"), "fleet audit reports configured-empty projects");
  assert(audit?.projects?.some((project) => project.name === "alpha_project" && project.schema_variants.includes("canonical_recipe_json")), "fleet audit reports schema variants");
  assert(audit?.projects?.some((project) => project.name === "alpha_project" && project.capabilities.includes("daily_runner") && project.entities.includes("portfolio")), "fleet audit reports capabilities and entities");
  assert(audit?.projects?.every((project) => Object.prototype.hasOwnProperty.call(project, "last_modified")), "fleet audit reports last-modified fields");
  assert(audit?.collisions?.some((collision) => collision.kind === "recipe_id" && collision.id === "daily-runner"), "fleet audit reports recipe ID collisions");
  assert(audit?.collisions?.some((collision) => collision.kind === "capability_id" && collision.id === "daily_runner"), "fleet audit reports capability ID collisions");
  assert(audit?.schema_drift?.some((entry) => entry.type === "legacy_recipe_shape" && entry.project === "legacy_project"), "fleet audit reports legacy schema drift");
  assert(audit?.schema_drift?.some((entry) => entry.type === "configured_empty" && entry.project === "empty_project"), "fleet audit reports empty schema drift");
  assert(audit?.migration_recommendations?.some((entry) => entry.action === "convert_legacy_runner_json_to_ipbs_recipe_json"), "fleet audit emits legacy migration recommendations");
  return audit;
}

function migrateIsReadOnly() {
  const temp = makeTemp("migrate");
  try {
    cpSync(fixtureDir, temp, { recursive: true });
    const before = snapshotFiles(temp);
    const result = run([plannerCliPath, "recipe", "fleet", "audit", "--config", join(temp, "config.yaml"), "--migrate", "--json"]);
    assert(result.ok, "planner recipe fleet audit --migrate exits cleanly");
    const audit = parseJson(result.stdout);
    assert(audit?.migration_plan?.mode === "plan_only", "migrate emits a plan-only migration plan");
    assert(audit?.migration_plan?.writes_performed === false, "migrate reports no writes performed");
    assert(audit?.migration_plan?.steps?.length > 0, "migrate emits migration steps");
    assertSnapshotUnchanged(before, temp, "migrate leaves fixture project files unchanged");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function discoveryEnrichment() {
  const temp = makeTemp("discovery");
  try {
    mkdirSync(join(temp, ".agent"), { recursive: true });
    mkdirSync(join(temp, "scripts", "prod"), { recursive: true });
    writeFileSync(join(temp, "scripts", "prod", "daily_runner.py"), "def main():\n    return 'daily'\n");
    writeFileSync(join(temp, ".agent", "recipe_fleet.config.yaml"), `projects:\n  - name: fixture_alpha\n    path: ${JSON.stringify(join(fixtureDir, "alpha_project"))}\n`);
    const result = run([discoveryCliPath, "--dir", temp, "--goal", "run daily runner", "--json"], repoRoot);
    assert(result.ok, "recipe discovery exits cleanly with fleet config");
    const payload = parseJson(result.stdout);
    const top = payload?.candidates?.[0];
    assert(top?.capability_id_guess === "daily_runner", "discovery keeps the canonical capability guess");
    assert(Array.isArray(top?.cross_fleet_capability_matches), "discovery emits cross_fleet_capability_matches array");
    assert(top.cross_fleet_capability_matches.some((match) => match.project === "fixture_alpha" && match.capability_id === "daily_runner"), "discovery includes advisory cross-fleet capability matches");
    assert(top.searched_surfaces.includes("recipe_fleet"), "discovery records recipe_fleet as a searched surface");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function dispatcherHelp() {
  const result = run([plannerCliPath, "help"]);
  assert(result.ok, "planner help exits cleanly");
  assert(result.stdout.includes("recipe fleet audit"), "planner help advertises recipe fleet audit");
}

auditFixture();
migrateIsReadOnly();
discoveryEnrichment();
dispatcherHelp();

console.log(`\nRecipe fleet audit tests: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
