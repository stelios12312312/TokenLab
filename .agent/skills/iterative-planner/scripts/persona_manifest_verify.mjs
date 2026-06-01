#!/usr/bin/env node
// persona_manifest_verify.mjs — Persona pack / seed-role / root-instruction
// drift detector. T-INTAKE-3B20A6BB / US-085.
//
// Manifest schema (v1):
// {
//   "schema_version": 1,
//   "rebaselined_at": "<ISO8601>",
//   "packs": {
//     "<pack_id>": {
//       "files": ["index.mjs", "rules.pl"],   // declared inventory
//       "hashes": { "<file>": "<sha256:32hex>" }
//     }
//   },
//   "persona_obligations": {
//     "path": ".agent/skills/iterative-planner/config/persona_obligations.json",
//     "hash": "<sha256:32hex>"
//   },
//   "root_instructions": {
//     "canonical": "CLAUDE.md",
//     "mirrors": ["GEMINI.md", "AGENTS.md"],
//     "policy": "byte_identical"
//   },
//   "recommended_seed_roles": ["<role>", ...]
// }
//
// Enforcement model:
//   - Local default:    exit 0; PASS/FAIL reported in stdout. Drift is
//                       advisory so daily development is not blocked.
//   - --strict:         exit 1 on any drift. The CI workflow runs with
//                       --strict so PRs FAIL when drift exists.
//   - --json:           emit { status, errors, warnings, counts } to stdout,
//                       same shape as program_manager.mjs check --json.
//   - --rebaseline:     overwrite persona_manifest.json from current disk
//                       state. Prints every changed hash so the diff is
//                       reviewable. Never silently mutates.
//
// The verifier deliberately does NOT consult .config_integrity. Persona-pack
// drift is a different concern from planner-core script integrity, and
// conflating the two obscures the audit trail.
//
// Bypass class context: memory project_gate_bypassability.md + G-072. An
// agent inside the planner edit surface can call --rebaseline to launder
// pack tampering. The cross-file diff check in
// .github/workflows/persona-manifest.yml is the real protection: a PR that
// edits packs/* MUST also commit a corresponding persona_manifest.json
// update, and the workflow asserts that cross-file consistency from a
// clean checkout.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const SKILL_DIR = dirname(SCRIPT_DIR);                    // .agent/skills/iterative-planner
const REPO_ROOT = resolve(SKILL_DIR, "..", "..", "..");   // project root
const MANIFEST_PATH = join(SKILL_DIR, "config", "persona_manifest.json");
const PACKS_DIR = join(SKILL_DIR, "packs");
const OBLIGATIONS_PATH = join(SKILL_DIR, "config", "persona_obligations.json");
const AUDIT_CONFIG_PATH = join(REPO_ROOT, "audit.config.json");
const PERSONA_ADAPT = join(SCRIPT_DIR, "persona_adapt.mjs");

// Convention: any pack directory whose name starts with "_" is scaffolding
// (e.g. _template, future _archetype_*) and must never appear in the manifest.
const isScaffoldingPack = (name) => name.startsWith("_");

const SCHEMA_VERSION = 1;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 64);
}

function readFileSafe(path) {
  return existsSync(path) ? readFileSync(path) : null;
}

function listPacks() {
  if (!existsSync(PACKS_DIR)) return [];
  return readdirSync(PACKS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !isScaffoldingPack(entry.name))
    .map(entry => entry.name)
    .sort();
}

function listPackFiles(packId) {
  const dir = join(PACKS_DIR, packId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith(".mjs") || name.endsWith(".pl"))
    .sort();
}

function computePackEntry(packId) {
  const files = listPackFiles(packId);
  const hashes = {};
  for (const file of files) {
    const buf = readFileSafe(join(PACKS_DIR, packId, file));
    if (buf) hashes[file] = sha256(buf);
  }
  return { files, hashes };
}

function readPersonaAdaptScan(projectRoot) {
  try {
    const out = execFileSync(process.execPath, [PERSONA_ADAPT, "scan", projectRoot, "--json"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out);
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

function buildManifest() {
  const manifest = {
    schema_version: SCHEMA_VERSION,
    rebaselined_at: new Date().toISOString(),
    packs: {},
    persona_obligations: {
      path: ".agent/skills/iterative-planner/config/persona_obligations.json",
      hash: null,
    },
    root_instructions: {
      canonical: "CLAUDE.md",
      mirrors: ["GEMINI.md", "AGENTS.md"],
      policy: "byte_identical",
    },
    recommended_seed_roles: [],
  };
  for (const packId of listPacks()) {
    manifest.packs[packId] = computePackEntry(packId);
  }
  const obligations = readFileSafe(OBLIGATIONS_PATH);
  if (obligations) manifest.persona_obligations.hash = sha256(obligations);
  const scan = readPersonaAdaptScan(REPO_ROOT);
  if (scan && Array.isArray(scan.recommended_seed_roles)) {
    manifest.recommended_seed_roles = [...scan.recommended_seed_roles].sort();
  }
  return manifest;
}

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) return null;
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function writeManifest(manifest) {
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}

function diffPackEntry(packId, expected, actual, errors) {
  const expectedFiles = new Set(expected?.files || []);
  const actualFiles = new Set(actual?.files || []);
  for (const file of expectedFiles) {
    if (!actualFiles.has(file)) {
      errors.push({
        code: "persona_pack_file_missing",
        path: `$.packs[${packId}].files`,
        message: `Pack ${packId} is missing declared file ${file}`,
      });
    }
  }
  for (const file of actualFiles) {
    if (!expectedFiles.has(file)) {
      errors.push({
        code: "persona_pack_file_unexpected",
        path: `$.packs[${packId}].files`,
        message: `Pack ${packId} has an undeclared file ${file} — run --rebaseline if intentional`,
      });
    }
  }
  for (const file of expectedFiles) {
    if (!actualFiles.has(file)) continue;
    const expectedHash = expected?.hashes?.[file];
    const actualHash = actual?.hashes?.[file];
    if (expectedHash && actualHash && expectedHash !== actualHash) {
      errors.push({
        code: "persona_pack_hash_drift",
        path: `$.packs[${packId}].hashes[${file}]`,
        message: `Pack ${packId} file ${file} hash drifted — run --rebaseline if intentional`,
      });
    }
  }
}

function verify({ scanSeedRoles = true } = {}) {
  const errors = [];
  const warnings = [];
  const manifest = loadManifest();
  if (!manifest) {
    errors.push({
      code: "persona_manifest_missing",
      path: "$",
      message: `Manifest not found at ${MANIFEST_PATH} — run --rebaseline to create it`,
    });
    return { status: "FAIL", errors, warnings, counts: { packs: 0 } };
  }

  if (manifest.schema_version !== SCHEMA_VERSION) {
    errors.push({
      code: "persona_manifest_schema_mismatch",
      path: "$.schema_version",
      message: `Expected schema_version ${SCHEMA_VERSION}, got ${manifest.schema_version}`,
    });
  }

  // Pack presence + hash check.
  const declaredPacks = new Set(Object.keys(manifest.packs || {}));
  const livePacks = new Set(listPacks());
  for (const packId of declaredPacks) {
    if (!livePacks.has(packId)) {
      errors.push({
        code: "persona_pack_missing",
        path: `$.packs[${packId}]`,
        message: `Declared pack ${packId} is missing from packs/`,
      });
      continue;
    }
    const actual = computePackEntry(packId);
    diffPackEntry(packId, manifest.packs[packId], actual, errors);
  }
  for (const packId of livePacks) {
    if (!declaredPacks.has(packId)) {
      errors.push({
        code: "persona_pack_undeclared",
        path: `$.packs[${packId}]`,
        message: `Pack ${packId} exists on disk but is not declared in the manifest — run --rebaseline if intentional`,
      });
    }
  }

  // persona_obligations.json hash.
  const expectedObligations = manifest.persona_obligations?.hash;
  const obligationsBuf = readFileSafe(OBLIGATIONS_PATH);
  if (!obligationsBuf) {
    errors.push({
      code: "persona_obligations_missing",
      path: "$.persona_obligations",
      message: `persona_obligations.json not found at ${OBLIGATIONS_PATH}`,
    });
  } else if (expectedObligations) {
    const actualHash = sha256(obligationsBuf);
    if (actualHash !== expectedObligations) {
      errors.push({
        code: "persona_obligations_hash_drift",
        path: "$.persona_obligations.hash",
        message: "persona_obligations.json hash drifted — run --rebaseline if intentional",
      });
    }
  }

  // Root instruction byte-identical parity.
  const policy = manifest.root_instructions?.policy;
  if (policy === "byte_identical") {
    const canonicalPath = join(REPO_ROOT, manifest.root_instructions.canonical || "CLAUDE.md");
    const canonical = readFileSafe(canonicalPath);
    if (!canonical) {
      errors.push({
        code: "root_instruction_canonical_missing",
        path: "$.root_instructions.canonical",
        message: `Canonical root instruction file ${canonicalPath} not found`,
      });
    } else {
      const canonicalHash = sha256(canonical);
      for (const mirror of manifest.root_instructions.mirrors || []) {
        const mirrorPath = join(REPO_ROOT, mirror);
        const mirrorBuf = readFileSafe(mirrorPath);
        if (!mirrorBuf) {
          errors.push({
            code: "root_instruction_mirror_missing",
            path: `$.root_instructions.mirrors[${mirror}]`,
            message: `Mirror root instruction file ${mirrorPath} not found`,
          });
          continue;
        }
        if (sha256(mirrorBuf) !== canonicalHash) {
          errors.push({
            code: "root_instruction_parity_drift",
            path: `$.root_instructions.mirrors[${mirror}]`,
            message: `${mirror} diverges from ${manifest.root_instructions.canonical} — re-run sync-instructions.sh`,
          });
        }
      }
    }
  }

  // Seed-role presence in audit.config.json.
  if (scanSeedRoles) {
    const requiredSeeds = manifest.recommended_seed_roles || [];
    const auditBuf = readFileSafe(AUDIT_CONFIG_PATH);
    let configuredRoles = [];
    if (auditBuf) {
      try {
        const parsed = JSON.parse(auditBuf.toString("utf-8"));
        configuredRoles = Array.isArray(parsed.roles) ? parsed.roles : [];
      } catch (err) {
        errors.push({
          code: "audit_config_unparseable",
          path: "$.recommended_seed_roles",
          message: `audit.config.json could not be parsed: ${err.message}`,
        });
      }
    }
    const configured = new Set(configuredRoles);
    for (const seed of requiredSeeds) {
      if (!configured.has(seed)) {
        errors.push({
          code: "persona_seed_role_missing",
          path: `$.recommended_seed_roles[${seed}]`,
          message: `audit.config.json roles is missing required seed role: ${seed}`,
        });
      }
    }
  }

  const status = errors.length === 0 ? "PASS" : "FAIL";
  return {
    status,
    errors,
    warnings,
    counts: {
      packs: Object.keys(manifest.packs || {}).length,
      required_seed_roles: (manifest.recommended_seed_roles || []).length,
    },
  };
}

function printText(result, strict) {
  console.log(`persona-manifest verify: ${result.status}`);
  console.log(`  packs:               ${result.counts.packs}`);
  console.log(`  required seed roles: ${result.counts.required_seed_roles}`);
  if (result.errors.length > 0) {
    console.log(`  errors (${result.errors.length}):`);
    for (const err of result.errors) {
      console.log(`    - [${err.code}] ${err.path} :: ${err.message}`);
    }
    console.log();
    console.log("Repair:");
    console.log("  Intentional pack/manifest change ->");
    console.log("    node .agent/skills/iterative-planner/scripts/persona_manifest_verify.mjs --rebaseline");
    console.log("  Unintentional drift -> revert the offending file and re-run verify.");
  }
  if (result.warnings.length > 0) {
    console.log(`  warnings (${result.warnings.length}):`);
    for (const warn of result.warnings) {
      console.log(`    - [${warn.code}] ${warn.path} :: ${warn.message}`);
    }
  }
  if (!strict && result.status === "FAIL") {
    console.log();
    console.log("Local default exit 0 (advisory). Use --strict in CI to FAIL on drift.");
  }
}

// F-003 closure: rebaseline is dry-run by default. --confirm writes the new
// manifest. --allow-uncommitted bypasses the dirty-tree check (only meaningful
// with --confirm). The dirty-tree check exists because an attacker's local
// laundering path is: edit a pack file, run `persona_manifest_verify rebaseline`,
// refresh hashes, and commit the cross-file diff. CI cross-file diff catches the
// PR-level laundering; this guard catches the local laundering.
function rebaseline({ confirm = false, allowUncommitted = false } = {}) {
  const previous = loadManifest();
  const next = buildManifest();
  // Compare structurally — rebaselined_at always differs and is not a real
  // change. The hashes + pack metadata are the substantive content.
  const stripTimestamp = (m) => {
    const copy = { ...m };
    delete copy.rebaselined_at;
    return JSON.stringify(copy, null, 2);
  };
  const isUnchanged = previous && stripTimestamp(previous) === stripTimestamp(next);

  if (isUnchanged) {
    console.log("persona_manifest.json is already current — no changes.");
    return { manifest: next, written: false, blocked: false, code: "rebaseline_no_change" };
  }

  // Print the diff regardless of mode — operators see what would change.
  if (previous) {
    console.log(confirm ? "persona_manifest.json updated:" : "persona_manifest.json would change (dry-run, no write):");
    for (const packId of new Set([...Object.keys(previous.packs || {}), ...Object.keys(next.packs || {})])) {
      const oldEntry = previous.packs?.[packId];
      const newEntry = next.packs?.[packId];
      if (!oldEntry && newEntry) console.log(`  + pack ${packId} added`);
      else if (oldEntry && !newEntry) console.log(`  - pack ${packId} removed`);
      else if (oldEntry && newEntry) {
        const files = new Set([...(oldEntry.files || []), ...(newEntry.files || [])]);
        for (const file of files) {
          const oldHash = oldEntry.hashes?.[file];
          const newHash = newEntry.hashes?.[file];
          if (oldHash !== newHash) {
            console.log(`  ~ ${packId}/${file}: ${oldHash || "(none)"} -> ${newHash || "(none)"}`);
          }
        }
      }
    }
    if (previous.persona_obligations?.hash !== next.persona_obligations?.hash) {
      console.log(`  ~ persona_obligations.json: ${previous.persona_obligations?.hash || "(none)"} -> ${next.persona_obligations?.hash}`);
    }
    if (JSON.stringify(previous.recommended_seed_roles || []) !== JSON.stringify(next.recommended_seed_roles)) {
      console.log(`  ~ recommended_seed_roles: ${JSON.stringify(previous.recommended_seed_roles || [])} -> ${JSON.stringify(next.recommended_seed_roles)}`);
    }
  } else if (confirm) {
    console.log("persona_manifest.json created.");
  } else {
    console.log("persona_manifest.json would be created (dry-run, no write).");
  }

  if (!confirm) {
    console.log();
    console.log("Dry-run mode. To actually write, re-run with --confirm.");
    return { manifest: next, written: false, blocked: false, code: "rebaseline_dry_run" };
  }

  if (!allowUncommitted) {
    const dirty = listDirtyManifestSurfaces();
    if (dirty.length > 0) {
      console.error("rebaseline_dirty_tree_blocked: uncommitted changes in pack/manifest surfaces.");
      for (const path of dirty) console.error(`  M ${path}`);
      console.error();
      console.error("Refusing to write — commit or stash these first, or re-run with --allow-uncommitted.");
      return { manifest: next, written: false, blocked: true, code: "rebaseline_dirty_tree_blocked" };
    }
  }

  writeManifest(next);
  return { manifest: next, written: true, blocked: false, code: previous ? "rebaseline_updated" : "rebaseline_created" };
}

// Returns the list of dirty paths inside packs/ or config/persona_manifest.json
// using `git status --porcelain`. Best-effort: if git is unavailable or this is
// not a git repo, returns [] (treat as clean).
function listDirtyManifestSurfaces() {
  try {
    const stdout = execFileSync("git", ["status", "--porcelain", "--", "packs", "config/persona_manifest.json"], {
      cwd: SKILL_DIR,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^[A-Z?!]+\s+/, ""));
  } catch {
    return [];
  }
}

function main() {
  const args = process.argv.slice(2);
  const subcommand = args.find(a => !a.startsWith("--")) || "verify";
  const strict = args.includes("--strict");
  const json = args.includes("--json");

  if (subcommand === "rebaseline" || args.includes("--rebaseline")) {
    const confirm = args.includes("--confirm");
    const allowUncommitted = args.includes("--allow-uncommitted");
    const result = rebaseline({ confirm, allowUncommitted });
    if (json) {
      console.log(JSON.stringify({
        status: result.blocked ? "BLOCKED" : (result.written ? "REBASELINED" : "DRY_RUN"),
        code: result.code,
        manifest_path: MANIFEST_PATH,
        packs: Object.keys(result.manifest.packs).length,
        written: result.written,
        blocked: result.blocked,
      }, null, 2));
    }
    process.exit(result.blocked ? 1 : 0);
  }

  if (subcommand === "verify") {
    const result = verify();
    if (json) {
      console.log(JSON.stringify({ command: "verify", ...result }, null, 2));
    } else {
      printText(result, strict);
    }
    if (strict && result.status !== "PASS") process.exit(1);
    process.exit(0);
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  console.error("Usage: persona_manifest_verify.mjs [verify|rebaseline] [--json] [--strict]");
  process.exit(2);
}

if (isDirectInvocation(import.meta.url)) {
  main();
}

export { verify, rebaseline, buildManifest, MANIFEST_PATH };
