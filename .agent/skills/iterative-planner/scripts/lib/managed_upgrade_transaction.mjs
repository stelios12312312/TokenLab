// @planner:story = US-015
// @planner:proves = sc_1, sc_2, sc_3, sc_4, sc_5, sc_6

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { randomBytes } from "crypto";
import { execFileSync, spawnSync } from "child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { tmpdir } from "os";
import { verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

export const MANAGED_UPGRADE_RECEIPT_RELATIVE_PATH =
  ".agent/skills/iterative-planner/config/last_upgrade_receipt.json";

const CONFIG_RELATIVE_PATH =
  ".agent/skills/iterative-planner/config/managed_upgrade_transaction.json";
const DEFAULT_JOURNAL_GIT_PATH = "iterative-planner/managed-upgrade";
const CANONICAL_SOURCE_REPO_ENV = "PLANNER_CANONICAL_SOURCE_REPO";
const PROOF_ATTESTATION_ENV = "_PLANNER_MANAGED_UPGRADE_PROOF_ATTESTATION";
const PROOF_ENVIRONMENT_KEYS_TO_CLEAR = Object.freeze([
  "_PLANNER_PINNED_SOURCE_RUNNING",
  "_PLANNER_MANAGED_UPGRADE_INTERNAL",
  "PLANNER_CANONICAL_SOURCE_REPO",
  "PLANNER_SOURCE_REF",
  "PLANNER_SOURCE_REF_RESOLVED",
  "PLANNER_SOURCE_COMMIT",
  "PLANNER_PROJECT_REGISTRY_PATH",
]);
const DEFAULT_PREFLIGHT_SCOPES = [
  ".agent/skills/iterative-planner",
  ".agent/rules.md",
  ".agent/scripts",
  ".agent/workflows",
  "CLAUDE.md",
  "GEMINI.md",
  "AGENTS.md",
  ".cursor/rules/iterative-planner.mdc",
  ".github/copilot-instructions.md",
  "audit.config.json",
  "planner.policy.yaml",
  "planner.policy.yml",
  "planner.policy.json",
  "plans/knowledge",
];
const REQUIRED_PROOF_SUITE_IDS = Object.freeze([
  "gate-or-delete-census",
  "migration-bootstrap",
  "preplanning-scaffolding",
  "transition-gate-flows",
]);
const ACTIVE_PHASES = new Set([
  "prepared",
  "applying",
  "proving",
  "candidate_ready",
  "advancing",
  "recovery_required",
]);

export function managedUpgradeProofEnvironment(baseEnvironment = process.env) {
  const proofEnvironment = { ...baseEnvironment };
  for (const key of PROOF_ENVIRONMENT_KEYS_TO_CLEAR) {
    delete proofEnvironment[key];
  }
  proofEnvironment._PLANNER_MANAGED_UPGRADE_PROOF_RUNNING = "1";
  proofEnvironment.NODE_V8_COVERAGE = "";
  return proofEnvironment;
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

function atomicWriteJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(temporary, path);
}

function git(targetPath, args, options = {}) {
  return execFileSync("git", ["-C", targetPath, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  }).trim();
}

function gitRaw(targetPath, args, options = {}) {
  return execFileSync("git", ["-C", targetPath, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function gitRoot(targetPath) {
  const requested = resolve(targetPath);
  const actual = resolve(git(requested, ["rev-parse", "--show-toplevel"]));
  const requestedReal = realpathSync(requested);
  const actualReal = realpathSync(actual);
  if (requestedReal !== actualReal) {
    throw new Error(`managed upgrade target must be a Git repository root (found ${actual})`);
  }
  return actualReal;
}

function gitDir(targetPath) {
  return resolve(targetPath, git(targetPath, ["rev-parse", "--git-dir"]));
}

function sourceConfig(sourceScript) {
  const configPath = resolve(dirname(sourceScript), "..", "config", "managed_upgrade_transaction.json");
  const parsed = readJson(configPath, {});
  const proofCommands = Array.isArray(parsed?.proof_commands)
    ? parsed.proof_commands
    : (Array.isArray(parsed?.proof_suite_ids) ? parsed.proof_suite_ids : []).map((id) => ({
        id,
        args: [
          ".agent/skills/iterative-planner/tests/ive/run.mjs",
          "--only",
          id,
          "--json",
          "--no-manifest",
        ],
        timeout_ms: Number(parsed?.proof_timeout_ms || 900_000),
      }));
  return {
    receipt_path: parsed?.receipt_path
      || parsed?.receipt_relative_path
      || MANAGED_UPGRADE_RECEIPT_RELATIVE_PATH,
    journal_git_path: parsed?.journal_git_path
      || parsed?.git_metadata_relative_path
      || DEFAULT_JOURNAL_GIT_PATH,
    preflight_scopes: Array.isArray(parsed?.preflight_scopes)
      ? parsed.preflight_scopes
      : DEFAULT_PREFLIGHT_SCOPES,
    proof_commands: proofCommands,
  };
}

function targetConfig(targetPath) {
  const parsed = readJson(join(targetPath, CONFIG_RELATIVE_PATH), {});
  return {
    receipt_path: parsed?.receipt_path
      || parsed?.receipt_relative_path
      || MANAGED_UPGRADE_RECEIPT_RELATIVE_PATH,
    journal_git_path: parsed?.journal_git_path
      || parsed?.git_metadata_relative_path
      || DEFAULT_JOURNAL_GIT_PATH,
    preflight_scopes: Array.isArray(parsed?.preflight_scopes)
      ? parsed.preflight_scopes
      : DEFAULT_PREFLIGHT_SCOPES,
  };
}

function journalPath(targetPath, config = targetConfig(targetPath)) {
  return join(gitDir(targetPath), config.journal_git_path, "transaction.json");
}

function removeManagedScratchFromJournal(journal) {
  const parent = journal?.scratch_parent;
  const candidate = journal?.scratch_path;
  if (typeof parent !== "string" || typeof candidate !== "string") return false;
  const normalizedParent = resolve(parent);
  const normalizedCandidate = resolve(candidate);
  const normalizedTmp = realpathSync(tmpdir());
  let parentRoot = normalizedParent;
  try {
    parentRoot = realpathSync(normalizedParent);
  } catch {
    // A missing scratch directory is already clean.
  }
  const safe = basename(normalizedParent).startsWith("planner-managed-upgrade-")
    && parentRoot.startsWith(`${normalizedTmp}/`)
    && normalizedCandidate === join(normalizedParent, "candidate");
  if (!safe) return false;
  rmSync(normalizedParent, { recursive: true, force: true });
  return true;
}

function persistJournal(journal) {
  journal.updated_at = new Date().toISOString();
  atomicWriteJson(journal.journal_path, journal);
  return journal;
}

function parsePlannerVersion(text) {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function treePlannerVersion(targetPath) {
  const versionPath = join(
    targetPath,
    ".agent/skills/iterative-planner/config/version.json",
  );
  if (existsSync(versionPath)) {
    const version = parsePlannerVersion(readFileSync(versionPath, "utf-8"));
    if (version) return version;
  }
  const skillPath = join(
    targetPath,
    ".agent/skills/iterative-planner/SKILL.md",
  );
  if (existsSync(skillPath)) {
    const marker = readFileSync(skillPath, "utf-8")
      .match(/planner_version:\s*["']?(\d+\.\d+\.\d+)["']?/);
    if (marker?.[1]) return marker[1];
  }
  return null;
}

export function readCommittedPlannerVersion(targetPath) {
  try {
    return parsePlannerVersion(git(targetPath, [
      "show",
      "HEAD:.agent/skills/iterative-planner/config/version.json",
    ])) || "unknown";
  } catch {
    return "unknown";
  }
}

function managedPreflightScopes(targetPath, scopes = DEFAULT_PREFLIGHT_SCOPES) {
  const targetRoot = resolve(targetPath);
  const expanded = new Set();
  for (const scope of scopes) {
    const absoluteScope = resolve(targetRoot, scope);
    const normalizedScope = relative(targetRoot, absoluteScope);
    if (
      !normalizedScope
      || normalizedScope === ".."
      || normalizedScope.startsWith(`..${sep}`)
      || isAbsolute(normalizedScope)
    ) {
      throw new Error(`managed upgrade preflight scope escapes target repository: ${scope}`);
    }
    expanded.add(normalizedScope.split(sep).join("/"));

    if (existsSync(absoluteScope)) {
      let resolvedTarget;
      try {
        resolvedTarget = realpathSync(absoluteScope);
      } catch {
        throw new Error(`managed upgrade refuses broken managed path: ${scope}`);
      }
      if (resolvedTarget !== absoluteScope) {
        const relativeTarget = relative(targetRoot, resolvedTarget);
        if (
          !relativeTarget
          || relativeTarget === ".."
          || relativeTarget.startsWith(`..${sep}`)
          || isAbsolute(relativeTarget)
        ) {
          throw new Error(
            `managed upgrade refuses managed symlink outside target repository: ${scope} -> ${resolvedTarget}`,
          );
        }
        expanded.add(relativeTarget.split(sep).join("/"));
      }
    }
  }
  return [...expanded];
}

function pathMatchesScope(relPath, scopes) {
  const norm = String(relPath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  for (const scope of scopes) {
    const normScope = String(scope || "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (norm === normScope || norm.startsWith(`${normScope}/`)) {
      return true;
    }
  }
  return false;
}

function managedStatus(targetPath, scopes = DEFAULT_PREFLIGHT_SCOPES) {
  const expandedScopes = managedPreflightScopes(targetPath, scopes);
  const output = git(targetPath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (!output) return "";
  const matching = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const pathPart = line.slice(3).trim();
    const paths = pathPart.includes(" -> ")
      ? pathPart.split(" -> ").map((p) => p.trim())
      : [pathPart];
    if (paths.some((p) => pathMatchesScope(p, expandedScopes))) {
      matching.push(line);
    }
  }
  return matching.join("\n");
}

function receiptPath(targetPath, config = targetConfig(targetPath)) {
  return join(targetPath, config.receipt_path);
}

function ensureReceiptIgnored(targetPath, config) {
  const excludePath = join(gitDir(targetPath), "info", "exclude");
  mkdirSync(dirname(excludePath), { recursive: true });
  const current = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
  const normalized = current.length === 0 || current.endsWith("\n") ? current : `${current}\n`;
  const rule = `/${config.receipt_path}`;
  if (!normalized.split("\n").map((line) => line.trim()).includes(rule)) {
    writeFileSync(excludePath, `${normalized}${rule}\n`);
  }
}

function writeReceipt(targetPath, config, journal, status, extra = {}) {
  ensureReceiptIgnored(targetPath, config);
  const payload = {
    schema_version: 1,
    transaction_id: journal.transaction_id,
    status,
    from_version: journal.from_version,
    to_version: journal.to_version,
    committed_version: status === "committed" ? journal.to_version : journal.from_version,
    tree_version: journal.to_version,
    source_version: journal.to_version,
    source_ref: journal.source_ref,
    source_commit: journal.source_commit,
    target_head_before: journal.head_before,
    file_count: journal.file_count || 0,
    conformance_result: journal.conformance_status || "unknown",
    conformance: journal.conformance || [],
    committing_sha: journal.candidate_sha || null,
    updated_at: new Date().toISOString(),
    ...extra,
  };
  atomicWriteJson(receiptPath(targetPath, config), payload);
  return payload;
}

function proofResultPasses(stdout, status) {
  if (status !== 0) return false;
  try {
    const parsed = JSON.parse(stdout || "{}");
    const verdict = String(parsed?.status || parsed?.summary?.status || "").toUpperCase();
    return verificationStatusIsPass(verdict, "execution");
  } catch {
    return false;
  }
}

function runProofBundle(scratchPath, config) {
  if (config.proof_commands.length === 0) {
    throw new Error("managed-upgrade conformance configuration contains no proof commands");
  }
  const proofIds = config.proof_commands.map((proof) => proof?.id).filter(Boolean);
  const duplicateIds = proofIds.filter((id, index) => proofIds.indexOf(id) !== index);
  const missingIds = REQUIRED_PROOF_SUITE_IDS.filter((id) => !proofIds.includes(id));
  if (duplicateIds.length > 0 || missingIds.length > 0) {
    throw new Error(
      "managed-upgrade conformance configuration is incomplete"
      + `${missingIds.length > 0 ? `; missing required suites: ${missingIds.join(", ")}` : ""}`
      + `${duplicateIds.length > 0 ? `; duplicate suites: ${[...new Set(duplicateIds)].join(", ")}` : ""}`,
    );
  }
  for (const proof of config.proof_commands) {
    const args = Array.isArray(proof?.args) ? proof.args : [];
    const onlyIndex = args.indexOf("--only");
    if (
      !proof?.id
      || args[0] !== ".agent/skills/iterative-planner/tests/ive/run.mjs"
      || onlyIndex < 0
      || args[onlyIndex + 1] !== proof.id
      || !args.includes("--json")
      || !args.includes("--no-manifest")
    ) {
      throw new Error(
        `managed-upgrade proof configuration contains an invalid command for ${proof?.id || "unknown"}`,
      );
    }
  }
  if (
    process.env._PLANNER_MANAGED_UPGRADE_PROOF_RUNNING === "1"
    && process.env._PLANNER_MANAGED_UPGRADE_TEST_MODE === "1"
  ) {
    return [{
      id: "parent-proof-owner",
      status: "PASS",
      skipped: true,
      reason: "outer migration-bootstrap/core proof owns recursive conformance",
    }];
  }

  const results = [];
  for (const proof of config.proof_commands) {
    const args = Array.isArray(proof?.args) ? proof.args : [];
    if (!proof?.id || args.length === 0) {
      throw new Error("managed-upgrade proof configuration contains an invalid command");
    }
    const script = join(scratchPath, args[0]);
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [script, ...args.slice(1)], {
      cwd: scratchPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: Number(proof.timeout_ms || 300_000),
      maxBuffer: 64 * 1024 * 1024,
      env: managedUpgradeProofEnvironment(process.env),
    });
    const passed = proofResultPasses(result.stdout, result.status);
    const record = {
      id: proof.id,
      status: passed ? "PASS" : "FAIL",
      exit_code: result.status,
      signal: result.signal || null,
      elapsed_ms: Date.now() - startedAt,
      stdout: passed ? null : String(result.stdout || "").trim().slice(-4000),
      stderr: passed ? null : String(result.stderr || "").trim().slice(0, 4000),
    };
    results.push(record);
    console.log(`  ${passed ? "✅" : "❌"} CONFORMANCE ${proof.id} (${record.elapsed_ms}ms)`);
    if (!passed) {
      const proofOutput = [record.stdout, record.stderr].filter(Boolean).join("\n");
      const error = new Error(
        `managed-upgrade conformance failed at ${proof.id}${proofOutput ? `:\n${proofOutput}` : ""}`,
      );
      error.conformance = results;
      throw error;
    }
  }
  return results;
}

function runInternalApply({
  scratchPath,
  sourceScript,
  sourceCommit,
  seedKB,
}) {
  const args = [
    sourceScript,
    "upgrade",
    scratchPath,
    "--source-ref",
    sourceCommit,
    "--transaction-apply",
  ];
  if (seedKB) args.push("--seed-kb");
  const result = spawnSync(process.execPath, args, {
    cwd: scratchPath,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 600_000,
    maxBuffer: 128 * 1024 * 1024,
    env: {
      ...process.env,
      _PLANNER_MANAGED_UPGRADE_INTERNAL: "1",
      NODE_V8_COVERAGE: "",
    },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0) {
    const detail = String(result.stderr || "").trim();
    throw new Error(`scratch apply failed (exit ${result.status ?? "unknown"})${detail ? `: ${detail}` : ""}`);
  }
}

function scratchCandidatePaths(scratchPath, scopes) {
  const tracked = gitRaw(scratchPath, [
    "diff",
    "--name-only",
    "-z",
    "HEAD",
    "--",
    ...scopes,
  ]).split("\0").filter(Boolean);
  const untracked = gitRaw(scratchPath, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...scopes,
  ]).split("\0").filter(Boolean);
  const ignored = gitRaw(scratchPath, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
    "--",
    ...scopes,
  ]).split("\0").filter(Boolean);
  return [...new Set([...tracked, ...untracked, ...ignored])].sort();
}

function commitScratch(
  scratchPath,
  candidatePaths,
  conformance,
  fromVersion,
  toVersion,
  sourceCommit,
) {
  // Proof commands may emit reports or other transient files. Commit only the
  // exact payload captured immediately after apply/setup, including deliberate
  // ignored-file migrations, so proof side effects cannot leak into consumers.
  git(scratchPath, ["add", "-f", "-A", "--", ...candidatePaths]);
  const staged = git(scratchPath, ["diff", "--cached", "--name-only"]);
  if (!staged) throw new Error("scratch upgrade produced no candidate diff");
  const proofIds = new Set(
    (conformance || [])
      .filter((entry) => verificationStatusIsPass(entry?.status, "execution"))
      .map((entry) => entry.id),
  );
  const completeProof = REQUIRED_PROOF_SUITE_IDS.every((id) => proofIds.has(id));
  const testParentOwned = process.env._PLANNER_MANAGED_UPGRADE_TEST_MODE === "1"
    && proofIds.has("parent-proof-owner");
  if (!completeProof && !testParentOwned) {
    throw new Error("scratch commit refused: the staged candidate has no complete conformance proof");
  }
  const attestationPath = join(
    gitDir(scratchPath),
    "iterative-planner",
    "managed-upgrade-proof.json",
  );
  atomicWriteJson(attestationPath, {
    schema_version: 1,
    status: "PASS",
    staged_tree_sha: git(scratchPath, ["write-tree"]),
    source_commit: sourceCommit,
    required_proof_suite_ids: REQUIRED_PROOF_SUITE_IDS,
    conformance,
    test_parent_owned: testParentOwned,
  });
  git(scratchPath, [
    "-c",
    "user.name=Iterative Planner",
    "-c",
    "user.email=iterative-planner@example.invalid",
    "commit",
    "-m",
    `chore(planner): upgrade to ${toVersion}`,
    "-m",
    `Why: prevent half-applied managed planner upgrades.\n\nWhat: upgrade ${fromVersion} -> ${toVersion} from ${sourceCommit}.\n\nProof: census and planner-core conformance passed in the scratch candidate.`,
  ], {
    env: {
      ...process.env,
      _PLANNER_MANAGED_UPGRADE_PROOF_RUNNING: "1",
      // The hook resolves the fixed attestation path from its own Git
      // metadata. A boolean marker avoids path-alias ambiguity and prevents a
      // caller from redirecting proof trust to arbitrary filesystem content.
      [PROOF_ATTESTATION_ENV]: "1",
      NODE_V8_COVERAGE: "",
    },
  });
  return git(scratchPath, ["rev-parse", "HEAD"]);
}

function committedCandidatePaths(scratchPath, candidateSha) {
  return gitRaw(scratchPath, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    "-z",
    candidateSha,
  ]).split("\0").filter(Boolean).sort();
}

function pathTrackedAtHead(targetPath, relativePath) {
  const result = spawnSync("git", [
    "-C",
    targetPath,
    "cat-file",
    "-e",
    `HEAD:${relativePath}`,
  ], { stdio: "ignore" });
  return result.status === 0;
}

function pathTrackedAtCommit(targetPath, commit, relativePath) {
  const result = spawnSync("git", [
    "-C",
    targetPath,
    "cat-file",
    "-e",
    `${commit}:${relativePath}`,
  ], { stdio: "ignore" });
  return result.status === 0;
}

function prepareUntrackedCollisionBackups(targetPath, journal, candidatePaths) {
  const backupRoot = join(
    dirname(journal.journal_path),
    "before-images",
    journal.transaction_id,
  );
  const backups = [];
  for (const relativePath of candidatePaths) {
    const livePath = join(targetPath, relativePath);
    if (!existsSync(livePath) || pathTrackedAtHead(targetPath, relativePath)) continue;
    const stat = lstatSync(livePath);
    if (!stat.isFile()) {
      throw new Error(
        `managed upgrade refuses non-file untracked collision at ${relativePath}`,
      );
    }
    const backupPath = join(backupRoot, relativePath);
    mkdirSync(dirname(backupPath), { recursive: true });
    copyFileSync(livePath, backupPath);
    chmodSync(backupPath, stat.mode & 0o777);
    backups.push({
      relative_path: relativePath,
      backup_path: backupPath,
      mode: stat.mode & 0o777,
    });
  }
  journal.untracked_collision_backups = backups;
  persistJournal(journal);
  for (const entry of backups) rmSync(join(targetPath, entry.relative_path));
  return backups;
}

function restoreUntrackedCollisionBackups(targetPath, journal) {
  for (const entry of journal.untracked_collision_backups || []) {
    if (!existsSync(entry.backup_path)) {
      throw new Error(
        `managed upgrade recovery backup missing for ${entry.relative_path}`,
      );
    }
    const livePath = join(targetPath, entry.relative_path);
    mkdirSync(dirname(livePath), { recursive: true });
    copyFileSync(entry.backup_path, livePath);
    chmodSync(livePath, entry.mode);
  }
}

function restoreCandidatePathsToBefore(targetPath, journal) {
  const trackedBefore = [];
  const absentBefore = [];
  for (const relativePath of journal.candidate_paths || []) {
    if (pathTrackedAtCommit(targetPath, journal.head_before, relativePath)) {
      trackedBefore.push(relativePath);
    } else {
      absentBefore.push(relativePath);
    }
  }
  if (trackedBefore.length > 0) {
    git(targetPath, [
      "restore",
      `--source=${journal.head_before}`,
      "--staged",
      "--worktree",
      "--",
      ...trackedBefore,
    ]);
  }
  for (const relativePath of absentBefore) {
    rmSync(join(targetPath, relativePath), { recursive: true, force: true });
    spawnSync(
      "git",
      ["-C", targetPath, "update-index", "--force-remove", "--", relativePath],
      { stdio: "ignore" },
    );
  }
  restoreUntrackedCollisionBackups(targetPath, journal);
}

function resolvedHookPath(targetPath) {
  const raw = git(targetPath, ["rev-parse", "--git-path", "hooks/pre-commit"]);
  return resolve(targetPath, raw);
}

function refreshLiveManagedHook(targetPath) {
  const sourcePath = join(
    targetPath,
    ".agent/skills/iterative-planner/scripts/hooks/pre-commit",
  );
  if (!existsSync(sourcePath)) return "source_missing";
  const hookPath = resolvedHookPath(targetPath);
  if (existsSync(hookPath)) {
    const current = readFileSync(hookPath, "utf-8");
    const managed = current.includes("iterative-planner managed pre-commit hook")
      || current.includes("iterative-planner ripple-check hook")
      || current.includes("scripts/pre_commit_policy.mjs")
      || current.includes("scripts/ripple_check.mjs");
    if (!managed) return "preserved_host_hook";
  }
  mkdirSync(dirname(hookPath), { recursive: true });
  copyFileSync(sourcePath, hookPath);
  chmodSync(hookPath, 0o755);
  return existsSync(hookPath) ? "installed_or_refreshed" : "failed";
}

function countCandidateFiles(scratchPath, candidateSha) {
  const output = git(scratchPath, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    candidateSha,
  ]);
  return output ? output.split("\n").filter(Boolean).length : 0;
}

function advanceLiveTarget(
  targetPath,
  scratchPath,
  candidateSha,
  headBefore,
  candidatePaths,
  journal,
) {
  const headNow = git(targetPath, ["rev-parse", "HEAD"]);
  if (headNow !== headBefore) {
    throw new Error(`live target HEAD changed during proof (${headBefore} -> ${headNow})`);
  }
  const candidateStatus = git(targetPath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ...candidatePaths,
  ]);
  if (candidateStatus) {
    throw new Error(`live target candidate paths changed during proof:\n${candidateStatus}`);
  }
  git(targetPath, ["fetch", "--no-tags", scratchPath, candidateSha]);
  const headAfterFetch = git(targetPath, ["rev-parse", "HEAD"]);
  if (headAfterFetch !== headBefore) {
    throw new Error(`live target HEAD changed before fast-forward (${headBefore} -> ${headAfterFetch})`);
  }
  prepareUntrackedCollisionBackups(targetPath, journal, candidatePaths);
  if (
    process.env.NODE_ENV === "test"
    && process.env._PLANNER_UPGRADE_TEST_CRASH_PHASE === "after_collision_backup"
  ) {
    process.stderr.write("TEST-ONLY: simulating process exit after durable collision backup\n");
    process.exit(86);
  }
  git(targetPath, ["merge", "--ff-only", "FETCH_HEAD"]);
  const actual = git(targetPath, ["rev-parse", "HEAD"]);
  if (actual !== candidateSha) {
    throw new Error(`live target HEAD ${actual} does not match proven candidate ${candidateSha}`);
  }
  if (
    process.env.NODE_ENV === "test"
    && process.env._PLANNER_UPGRADE_TEST_CRASH_PHASE === "after_fast_forward"
  ) {
    process.stderr.write("TEST-ONLY: simulating process exit after live fast-forward\n");
    process.exit(86);
  }
  journal.hook_status = refreshLiveManagedHook(targetPath);
  persistJournal(journal);
}

function stableSourceScriptPath(sourceScript) {
  const canonicalRepo = process.env[CANONICAL_SOURCE_REPO_ENV]?.trim();
  if (canonicalRepo) {
    return join(
      resolve(canonicalRepo),
      ".agent/skills/iterative-planner/scripts/migrate.mjs",
    );
  }
  return resolve(sourceScript || process.argv[1]);
}

function stableTargetPath(targetPath) {
  const target = resolve(targetPath);
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

export function managedUpgradeConsentCommand(
  targetPath,
  sourcePin,
  seedKB = false,
  sourceScript = null,
) {
  const seed = seedKB ? " --seed-kb" : "";
  return `node ${JSON.stringify(stableSourceScriptPath(sourceScript))} upgrade ${JSON.stringify(stableTargetPath(targetPath))} --source-ref ${sourcePin || "HEAD"} --commit${seed}`;
}

export function managedUpgradeRecoveryCommand(
  targetPath,
  sourcePin,
  sourceScript = null,
) {
  return `node ${JSON.stringify(stableSourceScriptPath(sourceScript))} recover-upgrade ${JSON.stringify(stableTargetPath(targetPath))} --source-ref ${sourcePin || "HEAD"}`;
}

export function runManagedUpgradeTransaction({
  targetPath,
  sourceScript,
  sourceRef,
  sourceCommit,
  fromVersion,
  toVersion,
  seedKB = false,
}) {
  const target = gitRoot(targetPath);
  const config = sourceConfig(sourceScript);
  const managedScopes = managedPreflightScopes(target, config.preflight_scopes);
  const activePath = journalPath(target, config);
  const previous = readJson(activePath);
  if (previous && ACTIVE_PHASES.has(previous.status)) {
    const error = new Error(
      `interrupted managed upgrade ${previous.transaction_id} detected`,
    );
    error.recovery = managedUpgradeRecoveryCommand(
      target,
      sourceCommit || sourceRef,
      sourceScript,
    );
    throw error;
  }

  const dirtyManaged = managedStatus(target, managedScopes);
  if (dirtyManaged) {
    const committed = readCommittedPlannerVersion(target);
    const tree = treePlannerVersion(target) || "unknown";
    const source = toVersion || "unknown";
    const error = new Error(
      `planner-managed target scope is dirty before upgrade:\n${dirtyManaged}\n`
      + `Version strata: committed=${committed} tree=${tree} source=${source}\n`
      + "half-applied payload detected (or managed divergence requiring the same safe recovery). "
      + "Preserve unrelated work, then stash or revert .agent/** and managed root snapshots to committed state.",
    );
    error.recovery = managedUpgradeConsentCommand(
      target,
      sourceCommit || sourceRef || "HEAD",
      seedKB,
      sourceScript,
    );
    throw error;
  }
  const now = new Date().toISOString();
  const journal = {
    schema_version: 1,
    transaction_id: `${now.replace(/[:.]/g, "-")}_${randomBytes(6).toString("hex")}`,
    status: "prepared",
    target_path: target,
    journal_path: activePath,
    head_before: git(target, ["rev-parse", "HEAD"]),
    from_version: fromVersion || readCommittedPlannerVersion(target),
    to_version: toVersion,
    source_ref: sourceRef,
    source_commit: sourceCommit,
    candidate_sha: null,
    file_count: 0,
    conformance_status: "pending",
    conformance: [],
    started_at: now,
    updated_at: now,
    managed_scopes: managedScopes,
  };
  persistJournal(journal);

  const scratchParent = mkdtempSync(join(tmpdir(), "planner-managed-upgrade-"));
  const scratchPath = join(scratchParent, "candidate");
  try {
    execFileSync("git", ["clone", "-q", "--no-hardlinks", target, scratchPath], {
      stdio: ["ignore", "ignore", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    git(scratchPath, ["checkout", "-q", journal.head_before]);
    journal.scratch_parent = scratchParent;
    journal.scratch_path = scratchPath;
    journal.status = "applying";
    persistJournal(journal);
    runInternalApply({
      scratchPath,
      sourceScript,
      sourceCommit,
      seedKB,
    });
    const candidatePaths = scratchCandidatePaths(
      scratchPath,
      managedScopes,
    );
    if (candidatePaths.length === 0) {
      throw new Error("scratch apply produced no candidate changes");
    }

    if (
      process.env.NODE_ENV === "test"
      && process.env._PLANNER_UPGRADE_TEST_FAIL_PHASE === "after_apply"
    ) {
      throw new Error("injected managed-upgrade failure after scratch apply");
    }

    journal.status = "proving";
    persistJournal(journal);
    journal.conformance = runProofBundle(scratchPath, config);
    journal.conformance_status = "PASS";
    persistJournal(journal);

    const candidateSha = commitScratch(
      scratchPath,
      candidatePaths,
      journal.conformance,
      journal.from_version,
      journal.to_version,
      journal.source_commit,
    );
    const committedPaths = committedCandidatePaths(scratchPath, candidateSha);
    journal.candidate_sha = candidateSha;
    journal.candidate_paths = committedPaths;
    journal.file_count = committedPaths.length;
    journal.status = "candidate_ready";
    persistJournal(journal);
    if (
      process.env.NODE_ENV === "test"
      && process.env._PLANNER_UPGRADE_TEST_CRASH_PHASE === "after_candidate"
    ) {
      process.stderr.write("TEST-ONLY: simulating process exit after candidate commit\n");
      process.exit(86);
    }

    journal.status = "advancing";
    persistJournal(journal);
    advanceLiveTarget(
      target,
      scratchPath,
      candidateSha,
      journal.head_before,
      committedPaths,
      journal,
    );

    journal.committed_at = new Date().toISOString();
    writeReceipt(target, config, journal, "committed");
    journal.status = "committed";
    persistJournal(journal);
    console.log(`\n  ✅ TRANSACTION COMMITTED ${candidateSha}`);
    console.log(`  Receipt: ${config.receipt_path}\n`);
    return {
      ok: true,
      status: "committed",
      target_path: target,
      committing_sha: candidateSha,
      receipt_path: config.receipt_path,
      conformance: journal.conformance,
    };
  } catch (error) {
    journal.failure = String(error.message || error);
    journal.conformance = error.conformance || journal.conformance;
    const currentHead = git(target, ["rev-parse", "HEAD"]);
    if (currentHead === journal.head_before) {
      journal.conformance_status = "FAIL";
      if (Array.isArray(journal.untracked_collision_backups)) {
        restoreCandidatePathsToBefore(target, journal);
      }
      journal.status = "rolled_back";
      journal.rolled_back_at = new Date().toISOString();
      persistJournal(journal);
      console.log("\n  ✅ ROLLBACK VERIFIED — live target HEAD and managed bytes were never advanced.");
    } else if (journal.candidate_sha && currentHead === journal.candidate_sha) {
      journal.status = "recovery_required";
      persistJournal(journal);
      error.liveTargetAdvanced = true;
      error.recovery = managedUpgradeRecoveryCommand(
        target,
        sourceCommit || sourceRef,
        sourceScript,
      );
    } else {
      journal.status = "recovery_required";
      persistJournal(journal);
      error.recovery = `node .agent/skills/iterative-planner/scripts/migrate.mjs recover-upgrade ${JSON.stringify(target)} --source-ref ${sourceCommit || sourceRef}`;
    }
    throw error;
  } finally {
    rmSync(scratchParent, { recursive: true, force: true });
  }
}

export function inspectManagedUpgradeState(targetPath) {
  try {
    const target = gitRoot(targetPath);
    const config = targetConfig(target);
    const transaction = readJson(journalPath(target, config));
    const receipt = readJson(receiptPath(target, config));
    return {
      ok: true,
      status: transaction?.status || receipt?.status || "none",
      active: !!transaction && ACTIVE_PHASES.has(transaction.status),
      transaction,
      receipt,
    };
  } catch (error) {
    return {
      ok: false,
      status: "unavailable",
      active: false,
      transaction: null,
      receipt: null,
      error: error.message,
    };
  }
}

export function managedUpgradeDiagnostics(targetPath, sourceVersion) {
  const committedVersion = readCommittedPlannerVersion(targetPath);
  const treeVersion = treePlannerVersion(targetPath) || "unknown";
  const state = inspectManagedUpgradeState(targetPath);
  let managedDirty = false;
  try {
    const target = gitRoot(targetPath);
    managedDirty = !!managedStatus(target, targetConfig(target).preflight_scopes);
  } catch {
    managedDirty = true;
  }
  let classification = "coherent_committed";
  if (state.active) classification = "interrupted_transaction";
  else if (
    state.receipt?.status === "verified_awaiting_commit"
    && state.receipt?.tree_version === treeVersion
  ) {
    classification = "coherent_awaiting_commit";
  } else if (managedDirty && committedVersion !== treeVersion) {
    classification = "half_applied_upgrade";
  } else if (managedDirty) {
    classification = "managed_scope_dirty";
  } else if (committedVersion !== treeVersion) {
    classification = "version_stratigraphy_mismatch";
  }
  return {
    committed_version: committedVersion,
    tree_version: treeVersion,
    source_version: sourceVersion || "unknown",
    classification,
    version_stratigraphy: {
      committed: committedVersion,
      tree: treeVersion,
      source: sourceVersion || "unknown",
      classification,
    },
    managed_scope_dirty: managedDirty,
    active_transaction: state.active ? state.transaction : null,
    last_receipt: state.receipt || null,
  };
}

export function recoverManagedUpgrade(targetPath, { sourceCommit = null } = {}) {
  const target = gitRoot(targetPath);
  const config = targetConfig(target);
  const path = journalPath(target, config);
  const journal = readJson(path);
  if (!journal || !ACTIVE_PHASES.has(journal.status)) {
    return {
      ok: true,
      status: journal?.status || "no_transaction",
      target_path: target,
      target_head: git(target, ["rev-parse", "HEAD"]),
      recovered: false,
    };
  }
  if (journal.target_path && realpathSync(journal.target_path) !== target) {
    throw new Error(
      `managed upgrade recovery refused: journal target ${journal.target_path} does not match ${target}`,
    );
  }
  if (sourceCommit && journal.source_commit && sourceCommit !== journal.source_commit) {
    throw new Error(
      `managed upgrade recovery refused: selected source ${sourceCommit} does not match journal source ${journal.source_commit}`,
    );
  }
  const head = git(target, ["rev-parse", "HEAD"]);
  if (journal.candidate_sha && head === journal.candidate_sha) {
    journal.hook_status = refreshLiveManagedHook(target);
    journal.committed_at = new Date().toISOString();
    writeReceipt(target, config, journal, "committed");
    journal.status = "committed";
    persistJournal(journal);
    removeManagedScratchFromJournal(journal);
    return {
      ok: true,
      status: "committed",
      target_path: target,
      target_head: head,
      recovered: true,
    };
  }
  if (head === journal.head_before) {
    if (Array.isArray(journal.untracked_collision_backups)) {
      restoreCandidatePathsToBefore(target, journal);
    }
    journal.recovered_at = new Date().toISOString();
    writeReceipt(target, config, journal, "recovered", {
      tree_version: journal.from_version,
      committing_sha: null,
      recovery_result: "off_target_candidate_abandoned",
    });
    journal.status = "recovered";
    persistJournal(journal);
    removeManagedScratchFromJournal(journal);
    return {
      ok: true,
      status: "recovered",
      target_path: target,
      target_head: head,
      recovered: true,
    };
  }
  throw new Error(
    `managed upgrade recovery refused: target HEAD ${head} is neither before ${journal.head_before} nor candidate ${journal.candidate_sha || "unavailable"}`,
  );
}

// Backward-compatible names used by the incident regression import.
export const beginManagedUpgradeTransaction = runManagedUpgradeTransaction;
