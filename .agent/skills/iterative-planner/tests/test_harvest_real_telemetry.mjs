#!/usr/bin/env node
// @planner:module harvest_real_telemetry_test
// @planner:capability Well-formedness + consumer-compatibility contract for
// harvested real-telemetry fixtures (US-088, T-INTAKE-F28D005F). Asserts:
// (1) the harvester stages provenance-led JSONL fixtures whose gate_transition
// lines are byte-verbatim; (2) the live consumer (gate_false_failure_ledger)
// accepts staged fixtures; (3) harvesting is idempotent and --dry-run writes
// nothing; (4) committed fixtures (legacy + harvested) honor the golden shape;
// (5) when registered siblings exist on this machine, a real harvest passes
// the same contract (SKIPs loudly on clean checkouts, per G-079).

import { execFileSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { plannerSubprocessEnv } from "./helpers/env.mjs";

const TESTS_ROOT = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(TESTS_ROOT, "..");
const REPO_ROOT = resolve(SKILL_ROOT, "..", "..", "..");
const BOOTSTRAP = join(SKILL_ROOT, "scripts", "bootstrap.mjs");
const HARVESTER = join(SKILL_ROOT, "scripts", "harvest_real_telemetry.mjs");
const LEDGER = join(SKILL_ROOT, "scripts", "gate_false_failure_ledger.mjs");
const FIXTURES_DIR = join(TESTS_ROOT, "fixtures", "real_telemetry");
const DEFAULT_REGISTRY = join(SKILL_ROOT, "config", ".project_registry.json");
const portableOnly = process.argv.includes("--portable-only");
const requireReal = process.argv.includes("--require-real");
const HOST_PROOF_SKIP_EXIT_CODE = 78;
const HOST_PROOF_SKIP_PREFIX = "IVE_HOST_PROOF_SKIP:";

// Required keys are what the live consumer (gate_false_failure_ledger.mjs)
// actually reads. _prev_hash/_record_hash are NOT required: fleet projects on
// older planner versions emit records without hash-chaining (verified live:
// TokenLab plan_2026-06-09_55f19326ff45bbe3), and the consumer never reads them.
const GOLDEN_KEYS = ["timestamp", "type", "gate", "inputs", "checks", "decision", "next_state", "failure_codes"];

let passed = 0, failed = 0, skipped = 0;
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`); }
}
function skip(name, reason) { skipped++; console.log(`  SKIP: ${name} — ${reason}`); }

function runHarvester(args) {
  return execFileSync("node", [HARVESTER, ...args], { encoding: "utf-8" });
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return sha256Text(readFileSync(filePath));
}

function snapshotFiles(root) {
  const rows = [];
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) rows.push([relative(root, full), sha256File(full)]);
    }
  }
  walk(root);
  return JSON.stringify(rows);
}

function runBootstrap(projectRoot, registryPath, args = ["status"]) {
  const result = spawnSync(process.execPath, [BOOTSTRAP, ...args], {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: plannerSubprocessEnv({
      PLANNER_SKIP_SELF_HEAL: "1",
      PLANNER_PROJECT_REGISTRY_PATH: registryPath,
      PLANNER_SUPERVISOR_DISABLED: "1",
      PLANNER_SUPERVISOR_REQUIRED: undefined,
      PLANNER_SUPERVISOR_MOCK_RESPONSE: undefined,
      PLANNER_SUPERVISOR_MOCK_ERROR: undefined,
      PLANNER_SUPERVISOR_API_KEY: undefined,
    }),
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    output: `${result.stdout || ""}${result.stderr || ""}`,
  };
}

function hasExactOutputLine(output, expected) {
  return output.split(/\r?\n/).map((line) => line.trim()).includes(expected);
}

function snapshotsPreservePaths(before, after, paths) {
  const beforeMap = new Map(JSON.parse(before));
  const afterMap = new Map(JSON.parse(after));
  return paths.every((path) => beforeMap.get(path) === afterMap.get(path));
}

function runBootstrapReachabilityCase(label, reachability) {
  const root = mkdtempSync(join(tmpdir(), `harvest-bootstrap-${label}-`));
  try {
    const projects = reachability.map((reachable, index) => {
      const projectPath = join(root, reachable ? `reachable-${index}` : `missing-${index}`);
      if (reachable) {
        mkdirSync(projectPath, { recursive: true });
        writeFileSync(join(projectPath, "sentinel.txt"), `sentinel-${index}\n`);
      }
      return { path: projectPath, type: "standard" };
    });
    const registryPath = join(root, "registry.json");
    writeFileSync(registryPath, `${JSON.stringify({ projects }, null, 2)}\n`);
    const before = snapshotFiles(root);
    const result = runBootstrap(root, registryPath);
    const after = snapshotFiles(root);
    return { ...result, before, after, projects, registryPath };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runBootstrapRawRegistryCase(label, content) {
  const root = mkdtempSync(join(tmpdir(), `harvest-bootstrap-${label}-`));
  try {
    const registryPath = join(root, "registry.json");
    writeFileSync(registryPath, content);
    const before = snapshotFiles(root);
    const result = runBootstrap(root, registryPath);
    const after = snapshotFiles(root);
    return { ...result, before, after };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runBootstrapNewCase() {
  const root = mkdtempSync(join(tmpdir(), "harvest-bootstrap-new-"));
  try {
    const projects = [
      { path: join(root, "new-missing-alpha"), type: "standard" },
      { path: join(root, "new-missing-beta"), type: "standard" },
    ];
    const registryPath = join(root, "registry.json");
    writeFileSync(registryPath, `${JSON.stringify({ projects }, null, 2)}\n`);
    const registryBefore = sha256File(registryPath);
    const indexPath = join(root, "plans", "INDEX.md");
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, "# Plan Index\n\nsentinel-before-new\n");
    const created = runBootstrap(root, registryPath, [
      "new",
      "--force",
      "Migrate shared planner integration configuration with regression proof",
    ]);
    const refreshedIndex = readFileSync(indexPath, "utf-8");
    const existingIndexRefreshed = refreshedIndex.startsWith("# Plan Index\n") && !refreshedIndex.includes("sentinel-before-new");
    const activeStatus = runBootstrap(root, registryPath);
    return {
      created,
      activeStatus,
      projects,
      registryUnchanged: sha256File(registryPath) === registryBefore,
      planCreated: existsSync(join(root, "plans", ".current_plan")),
      existingIndexRefreshed,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runBootstrapConfiguredStatusCase() {
  const root = mkdtempSync(join(tmpdir(), "harvest-bootstrap-configured-"));
  try {
    const registryPath = join(root, "registry.json");
    const projects = [{ path: join(root, "configured-missing"), type: "standard" }];
    writeFileSync(registryPath, `${JSON.stringify({ projects }, null, 2)}\n`);
    mkdirSync(join(root, "plans"), { recursive: true });
    writeFileSync(join(root, "plans", ".current_plan"), "plan_missing\n");
    writeFileSync(join(root, "planner.profile.json"), `${JSON.stringify({ install_profile: "kernel" })}\n`);
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), `${JSON.stringify({ hooks: { PostToolUse: [] } })}\n`);
    const seededStatus = runBootstrap(root, registryPath);
    const indexPath = join(root, "plans", "INDEX.md");
    const missingIndexNotSeeded = seededStatus.status === 0 && !existsSync(indexPath);
    writeFileSync(indexPath, "# Plan Index\n\nsentinel-existing-index\n");
    const before = snapshotFiles(root);
    const result = runBootstrap(root, registryPath);
    const after = snapshotFiles(root);
    return { ...result, before, after, projects, missingIndexNotSeeded };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function canonicalPath(filePath) {
  try { return realpathSync(filePath); } catch { return resolve(filePath); }
}

function directDecisionLogs(projectPath) {
  const plansDir = join(projectPath, "plans");
  if (!existsSync(plansDir)) return [];
  let entries;
  try { entries = readdirSync(plansDir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("plan_"))
    .map((entry) => ({
      planId: entry.name,
      logPath: join(plansDir, entry.name, "artifacts", "decision_log.jsonl"),
    }))
    .filter((entry) => existsSync(entry.logPath))
    .sort((a, b) => a.planId.localeCompare(b.planId));
}

function projectSlug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function firstDirectGateCode(raw) {
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== "gate_transition") continue;
    const codes = [
      ...(Array.isArray(entry.failure_codes) ? entry.failure_codes : []),
      ...(Array.isArray(entry.checks) ? entry.checks.map((item) => item?.code) : []),
    ];
    const code = codes.find((value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value));
    if (code) return code;
  }
  return null;
}

function telemetryCorpusDigest(projectPath) {
  const logs = directDecisionLogs(projectPath);
  const hash = createHash("sha256");
  for (const entry of logs) {
    let content;
    try { content = readFileSync(entry.logPath); } catch { return null; }
    hash.update(relative(projectPath, entry.logPath));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return { digest: hash.digest("hex"), logCount: logs.length };
}

function sourceChainFromRaw(raw) {
  let hashedRecords = 0;
  let chainBreaks = 0;
  let previousHash = null;
  let firstHashed = true;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry?._record_hash !== "string") continue;
    hashedRecords++;
    if (!firstHashed && entry._prev_hash !== previousHash) chainBreaks++;
    previousHash = entry._record_hash;
    firstHashed = false;
  }
  return hashedRecords === 0 ? "absent" : chainBreaks === 0 ? "intact" : "broken";
}

function discoverRealSibling(registry) {
  const currentRoot = canonicalPath(REPO_ROOT);
  const registered = (registry.projects || []).filter((project) => typeof project?.path === "string" && project.path.trim());
  const deduped = new Map();
  for (const project of registered) {
    const projectPath = canonicalPath(project.path);
    if (!deduped.has(projectPath)) deduped.set(projectPath, project);
  }
  const slugCounts = new Map();
  for (const projectPath of deduped.keys()) {
    const slug = projectSlug(basename(projectPath));
    slugCounts.set(slug, (slugCounts.get(slug) || 0) + 1);
  }

  const reachable = [...deduped.keys()].filter((projectPath) =>
    projectPath !== currentRoot &&
    existsSync(projectPath) &&
    existsSync(join(projectPath, "plans")) &&
    slugCounts.get(projectSlug(basename(projectPath))) === 1
  );
  const candidates = [];
  for (const projectPath of reachable) {
    const corpus = telemetryCorpusDigest(projectPath);
    if (!corpus) continue;
    const logs = directDecisionLogs(projectPath);
    for (const log of logs) {
      let raw;
      try { raw = readFileSync(log.logPath, "utf-8"); } catch { continue; }
      const code = firstDirectGateCode(raw);
      if (!code) continue;
      candidates.push({
        name: basename(projectPath),
        path: projectPath,
        planId: log.planId,
        logPath: log.logPath,
        code,
        logCount: corpus.logCount,
      });
      break;
    }
  }
  candidates.sort((a, b) =>
    a.logCount - b.logCount ||
    a.name.localeCompare(b.name) ||
    a.path.localeCompare(b.path) ||
    a.planId.localeCompare(b.planId) ||
    a.code.localeCompare(b.code)
  );
  return {
    candidate: candidates[0] || null,
    registeredCount: registered.length,
    reachableCount: reachable.length,
    candidateCount: candidates.length,
  };
}

function assertFixtureShape(label, content, { expectProvenance }) {
  const lines = content.split("\n").filter((l) => l.trim());
  check(`${label}: parses as JSONL`, lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
  const entries = lines.map((l) => JSON.parse(l));
  let body = entries;
  if (expectProvenance) {
    const prov = entries[0];
    check(`${label}: line 1 is harvest_provenance`, prov?.type === "harvest_provenance");
    for (const key of ["source_project", "plan_id", "source_path", "gate_code", "record_count", "harvested_at"]) {
      check(`${label}: provenance has ${key}`, prov != null && prov[key] !== undefined && prov[key] !== null && prov[key] !== "");
    }
    body = entries.slice(1);
    check(`${label}: provenance record_count matches body`, prov?.record_count === body.length);
  }
  check(`${label}: body is gate_transition records`, body.length > 0 && body.every((e) => e?.type === "gate_transition"));
  const missing = body.flatMap((e, i) => GOLDEN_KEYS.filter((k) => !(k in e)).map((k) => `line${i}:${k}`));
  check(`${label}: golden key set present on every record`, missing.length === 0, missing.slice(0, 4).join(", "));
}

function runLedgerOverFixture(content) {
  const repo = mkdtempSync(join(tmpdir(), "harvest-consumer-"));
  try {
    mkdirSync(join(repo, "plans", "plan_real", "artifacts"), { recursive: true });
    writeFileSync(join(repo, "plans", "plan_real", "artifacts", "decision_log.jsonl"), content);
    const out = execFileSync("node", [LEDGER, "--cwd", repo, "--json"], { encoding: "utf-8" });
    return JSON.parse(out);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
console.log("\nHarvest Real Telemetry Contract Test\n");

// ── Leg 0: bootstrap exposes a read-only all-unreachable registry ─────────
const zeroOfTwo = runBootstrapReachabilityCase("zero-of-two", [false, false]);
check("bootstrap 0/N: status exits zero", zeroOfTwo.status === 0, `exit ${zeroOfTwo.status}`);
check("bootstrap 0/N: warning reports exact ratio", hasExactOutputLine(zeroOfTwo.output, "Project registry reachability warning: 0/2 registered project path(s) resolve on this host."));
check("bootstrap 0/N: warning gives exact relative rescan command", hasExactOutputLine(zeroOfTwo.output, "Rescan this host's sibling planner installations with: node .agent/skills/iterative-planner/scripts/migrate.mjs scan .."));
check("bootstrap 0/N: warning does not leak registered paths", zeroOfTwo.projects.every((project) => !zeroOfTwo.output.includes(project.path)));
check("bootstrap 0/N: warning does not leak registered basenames", zeroOfTwo.projects.every((project) => !zeroOfTwo.output.includes(basename(project.path))));
check("bootstrap 0/N: status leaves workspace bytes unchanged", zeroOfTwo.after === zeroOfTwo.before);

const oneOfTwo = runBootstrapReachabilityCase("one-of-two", [true, false]);
check("bootstrap 1/N: status exits zero", oneOfTwo.status === 0, `exit ${oneOfTwo.status}`);
check("bootstrap 1/N: warning stays quiet", !oneOfTwo.output.includes("Project registry reachability warning:") && !oneOfTwo.output.includes("migrate.mjs scan .."));
check("bootstrap 1/N: status leaves registry and sentinel bytes unchanged", oneOfTwo.after === oneOfTwo.before);

const zeroOfZero = runBootstrapReachabilityCase("zero-of-zero", []);
check("bootstrap 0/0: status exits zero", zeroOfZero.status === 0, `exit ${zeroOfZero.status}`);
check("bootstrap 0/0: warning stays quiet", !zeroOfZero.output.includes("Project registry reachability warning:") && !zeroOfZero.output.includes("migrate.mjs scan .."));
check("bootstrap 0/0: status leaves registry bytes unchanged", zeroOfZero.after === zeroOfZero.before);

const malformedRegistry = runBootstrapRawRegistryCase("malformed", "{not-json\n");
check("bootstrap malformed registry: status exits zero", malformedRegistry.status === 0, `exit ${malformedRegistry.status}`);
check("bootstrap malformed registry: warning stays quiet", !malformedRegistry.output.includes("Project registry reachability warning:"));
check("bootstrap malformed registry: bytes stay unchanged", malformedRegistry.after === malformedRegistry.before);

const nonArrayRegistry = runBootstrapRawRegistryCase("non-array", `${JSON.stringify({ projects: {} })}\n`);
check("bootstrap non-array registry: status exits zero", nonArrayRegistry.status === 0, `exit ${nonArrayRegistry.status}`);
check("bootstrap non-array registry: warning stays quiet", !nonArrayRegistry.output.includes("Project registry reachability warning:"));
check("bootstrap non-array registry: bytes stay unchanged", nonArrayRegistry.after === nonArrayRegistry.before);

const invalidEntryRegistry = runBootstrapRawRegistryCase("invalid-entry", `${JSON.stringify({ projects: [{ path: "" }] })}\n`);
check("bootstrap invalid-entry registry: status exits zero", invalidEntryRegistry.status === 0, `exit ${invalidEntryRegistry.status}`);
check("bootstrap invalid-entry registry: warning stays quiet", !invalidEntryRegistry.output.includes("Project registry reachability warning:"));
check("bootstrap invalid-entry registry: bytes stay unchanged", invalidEntryRegistry.after === invalidEntryRegistry.before);

const configuredStatus = runBootstrapConfiguredStatusCase();
check("bootstrap configured status: command exits zero", configuredStatus.status === 0, `exit ${configuredStatus.status}`);
check("bootstrap configured status: missing compact index is not reseeded by status", configuredStatus.missingIndexNotSeeded);
check("bootstrap configured status: stale pointer stays inactive", configuredStatus.output.includes("No active plan"));
check("bootstrap configured status: kernel profile is reported", configuredStatus.output.includes("Kernel profile: active (planner.profile.json)"));
check("bootstrap configured status: configured telemetry hook suppresses health warning", !configuredStatus.output.includes("Telemetry capture is enabled but inactive"));
check("bootstrap configured status: 0/N registry warning remains exact", hasExactOutputLine(configuredStatus.output, "Project registry reachability warning: 0/1 registered project path(s) resolve on this host."));
check("bootstrap configured status: registry path and basename remain redacted", configuredStatus.projects.every((project) =>
  !configuredStatus.output.includes(project.path) && !configuredStatus.output.includes(basename(project.path))
));
check("bootstrap configured status: registry and control bytes stay unchanged", snapshotsPreservePaths(
  configuredStatus.before,
  configuredStatus.after,
  ["registry.json", "planner.profile.json", ".claude/settings.json", "plans/.current_plan", "plans/INDEX.md"],
));

const bootstrapNew = runBootstrapNewCase();
check("bootstrap new 0/N: command exits zero", bootstrapNew.created.status === 0, `exit ${bootstrapNew.created.status}`);
check("bootstrap new 0/N: intended plan is created", bootstrapNew.planCreated);
check("bootstrap new 0/N: existing compact index is refreshed", bootstrapNew.existingIndexRefreshed);
check("bootstrap new 0/N: warning reports exact ratio", hasExactOutputLine(bootstrapNew.created.output, "Project registry reachability warning: 0/2 registered project path(s) resolve on this host."));
check("bootstrap new 0/N: warning gives exact relative rescan command", hasExactOutputLine(bootstrapNew.created.output, "Rescan this host's sibling planner installations with: node .agent/skills/iterative-planner/scripts/migrate.mjs scan .."));
check("bootstrap new 0/N: warning does not leak registered paths or basenames", bootstrapNew.projects.every((project) =>
  !bootstrapNew.created.output.includes(project.path) && !bootstrapNew.created.output.includes(basename(project.path))
));
check("bootstrap new 0/N: registry bytes stay unchanged", bootstrapNew.registryUnchanged);
check("bootstrap active status 0/N: command exits zero", bootstrapNew.activeStatus.status === 0, `exit ${bootstrapNew.activeStatus.status}`);
check("bootstrap active status 0/N: warning reports exact ratio and guidance",
  hasExactOutputLine(bootstrapNew.activeStatus.output, "Project registry reachability warning: 0/2 registered project path(s) resolve on this host.") &&
  hasExactOutputLine(bootstrapNew.activeStatus.output, "Rescan this host's sibling planner installations with: node .agent/skills/iterative-planner/scripts/migrate.mjs scan ..")
);
check("bootstrap active status 0/N: warning does not leak registered paths or basenames", bootstrapNew.projects.every((project) =>
  !bootstrapNew.activeStatus.output.includes(project.path) && !bootstrapNew.activeStatus.output.includes(basename(project.path))
));

// ── Leg 1: synthetic project (CI-safe, no siblings required) ──────────────
const work = mkdtempSync(join(tmpdir(), "harvest-synth-"));
try {
  const projDir = join(work, "synthetic-project");
  const planArtifacts = join(projDir, "plans", "plan_2026-01-01_aaaa", "artifacts");
  mkdirSync(planArtifacts, { recursive: true });

  const mkRecord = (i, codes) => JSON.stringify({
    timestamp: `2026-01-01T00:0${i}:00.000Z`, type: "gate_transition", gate: "explore-to-plan",
    inputs: { plan: "plan_2026-01-01_aaaa", source_state: "explore" },
    checks: [{ name: "synthetic", status: codes.length ? "FAIL" : "PASS", code: codes[0] || null }],
    decision: codes.length ? "blocked" : "allowed", next_state: codes.length ? "explore" : "plan",
    failure_codes: codes, _prev_hash: `h${i - 1}`, _record_hash: `h${i}`,
  });
  const sourceLines = [
    mkRecord(1, ["GATE-TST-001"]),
    JSON.stringify({ type: "note", detail: "non-transition record the harvester must filter" }),
    `  ${mkRecord(2, ["GATE-TST-001"])}  `,
    "not-json-at-all",
    mkRecord(3, []),
  ];
  writeFileSync(join(planArtifacts, "decision_log.jsonl"), sourceLines.join("\n") + "\n");

  const registryPath = join(work, "registry.json");
  writeFileSync(registryPath, JSON.stringify({ projects: [{ path: projDir, type: "standard" }] }, null, 2));
  const outDir = join(work, "out");

  // --dry-run writes nothing
  runHarvester(["--project", "synthetic-project", "--gate", "GATE-TST-001", "--registry", registryPath, "--out", outDir, "--dry-run"]);
  check("synthetic: --dry-run writes nothing", !existsSync(outDir) || readdirSync(outDir).length === 0);

  // real harvest
  runHarvester(["--project", "synthetic-project", "--gate", "GATE-TST-001", "--registry", registryPath, "--out", outDir]);
  const fixturePath = join(outDir, "synthetic_project_GATE-TST-001.jsonl");
  check("synthetic: fixture staged", existsSync(fixturePath));
  const content = readFileSync(fixturePath, "utf-8");
  assertFixtureShape("synthetic", content, { expectProvenance: true });

  // byte-verbatim body: each body line must appear verbatim in the source
  const bodyLines = content.split("\n").filter((l) => l.trim()).slice(1);
  const sourceTransitionLines = [sourceLines[0], sourceLines[2], sourceLines[4]];
  check(
    "synthetic: gate_transition lines remain byte-verbatim and ordered, including legal padding",
    JSON.stringify(bodyLines) === JSON.stringify(sourceTransitionLines),
  );
  check("synthetic: non-gate_transition source lines filtered", bodyLines.length === 3);
  const prov = JSON.parse(content.split("\n")[0]);
  check("synthetic: skipped_lines counted in provenance", prov.skipped_lines === 2);

  // idempotency
  runHarvester(["--project", "synthetic-project", "--gate", "GATE-TST-001", "--registry", registryPath, "--out", outDir]);
  check("synthetic: re-harvest is byte-identical", readFileSync(fixturePath, "utf-8") === content);

  // consumer compatibility (live ledger over provenance-led fixture)
  const ledger = runLedgerOverFixture(content);
  check("synthetic: live consumer parses staged fixture", ledger?.plan_count === 1);
  check("synthetic: live consumer scored the gate", ledger?.gates?.["explore-to-plan"]?.attempts === 3);

  // unknown gate exits non-zero, writes nothing
  let failedAsExpected = false;
  try { runHarvester(["--project", "synthetic-project", "--gate", "GATE-NOPE-999", "--registry", registryPath, "--out", outDir]); }
  catch { failedAsExpected = true; }
  check("synthetic: unmatched gate exits non-zero", failedAsExpected);
  check("synthetic: unmatched gate writes no fixture", !existsSync(join(outDir, "synthetic_project_GATE-NOPE-999.jsonl")));
} finally {
  rmSync(work, { recursive: true, force: true });
}

// ── Leg 2: committed fixtures honor the golden shape ──────────────────────
for (const name of readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".jsonl")).sort()) {
  const content = readFileSync(join(FIXTURES_DIR, name), "utf-8");
  const first = JSON.parse(content.split("\n").find((l) => l.trim()));
  assertFixtureShape(`committed ${name}`, content, { expectProvenance: first?.type === "harvest_provenance" });
}

// ── Leg 3: real registered sibling → harvester → live consumer ────────────
let realLegRan = false;
let realLegExercised = false;
let realSkipReason = "";
if (portableOnly) {
  check("portable: mutable host integration is delegated to harvest-real-telemetry-host", true);
  realLegRan = true;
} else if (existsSync(DEFAULT_REGISTRY)) {
  const registry = JSON.parse(readFileSync(DEFAULT_REGISTRY, "utf-8"));
  const discovery = discoverRealSibling(registry);
  const selected = discovery.candidate;
  if (selected) {
    const registryBefore = sha256File(DEFAULT_REGISTRY);
    const corpusBefore = telemetryCorpusDigest(selected.path);
    const realWork = mkdtempSync(join(tmpdir(), "harvest-real-"));
    try {
      const outDir = join(realWork, "out");
      const commonArgs = [
        "--project", selected.name,
        "--gate", selected.code,
        "--plan", selected.planId,
        "--registry", DEFAULT_REGISTRY,
        "--out", outDir,
        "--json",
      ];

      const listOut = JSON.parse(runHarvester(["--list", "--registry", DEFAULT_REGISTRY, "--json"]));
      check("real: --list enumerates registry projects", Array.isArray(listOut.projects) && listOut.projects.length === (registry.projects || []).length);
      check(`real: selected ${selected.name} ${selected.planId} ${selected.code}`, true);
      check("real: selected source is a non-current registered sibling", selected.path !== canonicalPath(REPO_ROOT) && (registry.projects || []).some((project) => canonicalPath(project?.path || "") === selected.path));
      check("real: discovered a direct failure/check code", Boolean(selected.code));

      const dryRun = JSON.parse(runHarvester([...commonArgs, "--dry-run"]));
      const dryResult = dryRun.results?.[0];
      check("real: dry-run reports the discovered gate", dryRun.gate === selected.code && dryRun.dry_run === true);
      check("real: dry-run selects the pinned source plan", dryRun.results?.length === 1 && dryResult?.status === "dry_run" && dryResult?.plan_id === selected.planId);
      check("real: dry-run reports positive records and matches", dryResult?.records > 0 && dryResult?.matches > 0);
      check("real: dry-run writes no output", !existsSync(outDir));
      check("real: dry-run leaves registry unchanged", sha256File(DEFAULT_REGISTRY) === registryBefore);
      check("real: dry-run leaves sibling telemetry corpus unchanged", JSON.stringify(telemetryCorpusDigest(selected.path)) === JSON.stringify(corpusBefore));

      const staged = JSON.parse(runHarvester(commonArgs));
      const stagedResult = staged.results?.[0];
      check("real: staging selects the pinned source plan", staged.results?.length === 1 && stagedResult?.status === "staged" && stagedResult?.plan_id === selected.planId);
      check("real: staging reports positive records and matches", stagedResult?.records > 0 && stagedResult?.matches > 0);
      check("real: staging writes exactly one temporary fixture", existsSync(outDir) && readdirSync(outDir).filter((name) => name.endsWith(".jsonl")).length === 1);
      check("real: staged fixture stays under the temporary output root", canonicalPath(stagedResult.out).startsWith(`${canonicalPath(outDir)}${sep}`));

      const content = readFileSync(stagedResult.out, "utf-8");
      assertFixtureShape("real", content, { expectProvenance: true });
      const fixtureLines = content.split("\n").filter((line) => line.trim());
      const provenance = JSON.parse(fixtureLines[0]);
      const bodyLines = fixtureLines.slice(1);
      const sourceRaw = readFileSync(selected.logPath, "utf-8");
      const sourceTransitionLines = sourceRaw.split("\n").filter((line) => {
        if (!line.trim()) return false;
        try { return JSON.parse(line)?.type === "gate_transition"; } catch { return false; }
      });
      const bodyEntries = bodyLines.map((line) => JSON.parse(line));
      const recomputedMatches = bodyEntries.filter((entry) =>
        entry.failure_codes?.includes(selected.code) ||
        entry.checks?.some((item) => item?.code === selected.code)
      ).length;

      check("real: provenance binds the registered sibling", provenance.source_project === selected.name && canonicalPath(provenance.source_project_path) === selected.path);
      check("real: provenance binds exact source plan, log, and code", provenance.plan_id === selected.planId && canonicalPath(provenance.source_path) === canonicalPath(selected.logPath) && provenance.gate_code === selected.code);
      check("real: provenance record and match counts are exact", provenance.record_count === bodyLines.length && provenance.match_count === recomputedMatches && recomputedMatches > 0);
      check("real: provenance timestamp and chain status match source", provenance.harvested_at === bodyEntries.at(-1)?.timestamp && provenance.source_chain === sourceChainFromRaw(sourceRaw));
      check("real: staged body is the complete byte-verbatim source transition set", JSON.stringify(bodyLines) === JSON.stringify(sourceTransitionLines));

      const ledger = runLedgerOverFixture(content);
      const attempts = Object.values(ledger?.gates || {}).reduce((sum, gate) => sum + (gate?.attempts || 0), 0);
      check("real: live consumer reads one staged plan", ledger?.plan_count === 1);
      check("real: live consumer attempts equal staged transitions", attempts === bodyLines.length && attempts > 0);
      check("real: staging leaves registry unchanged", sha256File(DEFAULT_REGISTRY) === registryBefore);
      check("real: staging leaves sibling telemetry corpus unchanged", JSON.stringify(telemetryCorpusDigest(selected.path)) === JSON.stringify(corpusBefore));
      realLegRan = true;
      realLegExercised = true;
    } finally {
      rmSync(realWork, { recursive: true, force: true });
    }
  } else {
    realSkipReason = `no registry-backed non-current telemetry candidate (registered=${discovery.registeredCount}, reachable_non_current=${discovery.reachableCount}, telemetry_candidates=${discovery.candidateCount})`;
    skip(
      "real sibling harvest",
      realSkipReason
    );
    realLegRan = true;
  }
}
if (!realLegRan) {
  realSkipReason = "registry absent on this machine (clean checkout) — synthetic leg covers the contract";
  skip("real sibling harvest", realSkipReason);
}

// ---------------------------------------------------------------------------
console.log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed > 0) {
  process.exit(1);
} else if (requireReal && !realLegExercised) {
  console.log(`${HOST_PROOF_SKIP_PREFIX} ${realSkipReason || "real sibling telemetry unavailable"}`);
  process.exit(HOST_PROOF_SKIP_EXIT_CODE);
}
