import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { join, relative, resolve } from "path";
import { tmpdir } from "os";

const PINNED_SOURCE_RUNNING_ENV = "_PLANNER_PINNED_SOURCE_RUNNING";
const CANONICAL_SOURCE_REPO_ENV = "PLANNER_CANONICAL_SOURCE_REPO";
const RESOLVED_SOURCE_REF_ENV = "PLANNER_SOURCE_REF_RESOLVED";
const RESOLVED_SOURCE_COMMIT_ENV = "PLANNER_SOURCE_COMMIT";

export function createMigrationSourcePin({ agentDir, fileHash, normalizeComparablePath }) {
  function canonicalSourceProjectPath() {
    const explicit = process.env[CANONICAL_SOURCE_REPO_ENV]?.trim();
    return explicit ? resolve(explicit) : resolve(join(agentDir, ".."));
  }

  function selectedSourceRef() {
    return process.env[RESOLVED_SOURCE_REF_ENV]?.trim() || process.env.PLANNER_SOURCE_REF?.trim() || "HEAD";
  }

  function gitText(repoPath, gitArgs) {
    try {
      return execFileSync("git", ["-C", repoPath, ...gitArgs], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 32 * 1024 * 1024,
      }).trim();
    } catch {
      return null;
    }
  }

  function selectedSourceCommit() {
    const explicit = process.env[RESOLVED_SOURCE_COMMIT_ENV]?.trim();
    if (explicit) return explicit;
    return gitText(canonicalSourceProjectPath(), ["rev-parse", "--verify", `${selectedSourceRef()}^{commit}`]);
  }

  function runFromPinnedSourceSnapshot(rawArgs, sourceRefArg, command, targetPath) {
    if (process.env[PINNED_SOURCE_RUNNING_ENV] === "1") return false;
    const fleetSourceCommand = command === "upgrade-all";
    if (
      (!targetPath && !fleetSourceCommand)
      || (targetPath && resolve(targetPath) === canonicalSourceProjectPath())
      || rawArgs.includes("--to-ive")
    ) return false;
    const sourceDrivenCommands = new Set([
      "detect", "doctor", "upgrade", "verify", "setup", "sync-instructions",
      "annotate", "promote-knowledge", "semantic-scan", "scaffold-discovery-policy",
      "kernel-status", "upgrade-approval-envelope", "recover-upgrade", "upgrade-all",
    ]);
    if (!sourceDrivenCommands.has(command)) return false;

    const sourceRepo = canonicalSourceProjectPath();
    const requestedRef = sourceRefArg || process.env.PLANNER_SOURCE_REF?.trim() || "HEAD";
    let sourceCommit;
    try {
      const gitRoot = execFileSync("git", ["-C", sourceRepo, "rev-parse", "--show-toplevel"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (resolve(gitRoot) !== resolve(sourceRepo)) {
        throw new Error(`canonical source must be a git repository root (found ${gitRoot})`);
      }
      sourceCommit = execFileSync("git", ["-C", sourceRepo, "rev-parse", "--verify", `${requestedRef}^{commit}`], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      console.error(`ERROR: source ref '${requestedRef}' could not be resolved in ${sourceRepo}; no managed files were written.`);
      if (error?.message) console.error(`  ${error.message.split("\n")[0]}`);
      process.exit(1);
    }

    const snapshotRoot = mkdtempSync(join(tmpdir(), "planner-source-snapshot-"));
    let childStatus = 1;
    try {
      const archive = execFileSync("git", ["-C", sourceRepo, "archive", "--format=tar", sourceCommit, ".agent"], {
        encoding: null,
        maxBuffer: 512 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const extract = spawnSync("tar", ["-xf", "-", "-C", snapshotRoot], {
        input: archive,
        stdio: ["pipe", "inherit", "inherit"],
      });
      if (extract.status !== 0) throw new Error(`failed to extract immutable source snapshot for ${sourceCommit}`);

      const snapshotScript = join(snapshotRoot, ".agent", "skills", "iterative-planner", "scripts", "migrate.mjs");
      if (!existsSync(snapshotScript)) throw new Error(`${sourceCommit} does not contain the planner migration runtime`);
      const childEnv = {
        ...process.env,
        [PINNED_SOURCE_RUNNING_ENV]: "1",
        [CANONICAL_SOURCE_REPO_ENV]: sourceRepo,
        [RESOLVED_SOURCE_REF_ENV]: requestedRef,
        [RESOLVED_SOURCE_COMMIT_ENV]: sourceCommit,
      };
      if (fleetSourceCommand && !childEnv.PLANNER_PROJECT_REGISTRY_PATH) {
        childEnv.PLANNER_PROJECT_REGISTRY_PATH = join(
          sourceRepo,
          ".agent",
          "skills",
          "iterative-planner",
          "config",
          ".project_registry.json",
        );
      }
      const child = spawnSync(process.execPath, [snapshotScript, ...rawArgs], {
        stdio: "inherit",
        env: childEnv,
      });
      childStatus = child.status ?? 1;
    } catch (error) {
      console.error(`ERROR: ${error.message}; no managed files were written.`);
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
    }
    process.exit(childStatus);
  }

  function gitPath(path) {
    return path.split("\\").join("/");
  }

  function managedDisplayPath(path) {
    const normalized = gitPath(path);
    const agentIndex = normalized.lastIndexOf("/.agent/");
    return agentIndex >= 0 ? normalized.slice(agentIndex + 1) : normalized;
  }

  function collectHistoricalBlobIds(repoPath, revisionArgs, relativePath) {
    const output = gitText(repoPath, ["log", ...revisionArgs, "--format=", "--raw", "--full-index", "--abbrev=64", "--", relativePath]);
    if (output === null) return null;
    const ids = new Set();
    const pattern = /^:\d+\s+\d+\s+([0-9a-f]+)\s+([0-9a-f]+)\s+[A-Z][0-9]*\t/gm;
    for (const match of output.matchAll(pattern)) {
      for (const oid of [match[1], match[2]]) if (!/^0+$/.test(oid)) ids.add(oid);
    }
    return ids;
  }

  const sourcePathHistoryCache = new Map();
  function sourcePathHasHistory(sourceRelativePath) {
    const normalizedPath = gitPath(sourceRelativePath);
    if (sourcePathHistoryCache.has(normalizedPath)) return sourcePathHistoryCache.get(normalizedPath);
    const blobs = collectHistoricalBlobIds(canonicalSourceProjectPath(), ["--all"], normalizedPath);
    const result = blobs === null ? null : blobs.size > 0;
    sourcePathHistoryCache.set(normalizedPath, result);
    return result;
  }

  let legacyProvenanceCache = null;
  function legacyBlobIdsFor(sourceRelativePath) {
    if (!legacyProvenanceCache) {
      const ledgerPath = join(
        agentDir,
        "skills",
        "iterative-planner",
        "config",
        "legacy_managed_blob_provenance.json",
      );
      const byPath = new Map();
      if (existsSync(ledgerPath)) {
        const document = JSON.parse(readFileSync(ledgerPath, "utf-8"));
        if (
          document?.schema_version !== 1
          || document?.policy !== "exact_same_path_blob_only"
          || !Array.isArray(document?.entries)
        ) {
          throw new Error(`invalid legacy managed-blob provenance ledger: ${ledgerPath}`);
        }
        for (const entry of document.entries) {
          const path = gitPath(String(entry?.path || "").trim());
          const blob = String(entry?.git_blob || "").trim().toLowerCase();
          if (
            !path.startsWith(".agent/")
            || path.includes("../")
            || !/^[0-9a-f]{40,64}$/.test(blob)
          ) {
            throw new Error(`invalid legacy managed-blob provenance entry for ${path || "<missing path>"}`);
          }
          if (!byPath.has(path)) byPath.set(path, new Set());
          byPath.get(path).add(blob);
        }
      }
      legacyProvenanceCache = byPath;
    }
    return legacyProvenanceCache.get(gitPath(sourceRelativePath)) || new Set();
  }

  function boundedDiffSummary(incomingPath, targetFilePath) {
    if (!incomingPath || !existsSync(incomingPath)) return "selected source removes this path; target content remains present";
    const result = spawnSync("git", ["diff", "--no-index", "--stat", "--", incomingPath, targetFilePath], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rendered = (result.stdout || result.stderr || "binary or metadata-only difference")
      .trim().split("\n").slice(0, 8).join("\n").slice(0, 2000);
    return rendered || "binary or metadata-only difference";
  }

  function plannerVersionFromText(text) {
    if (!text) return "unknown";
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.version === "string") return parsed.version;
    } catch {
      const match = String(text).match(/planner_version:\s*["']?(\d+\.\d+\.\d+)["']?/);
      if (match) return match[1];
    }
    return "unknown";
  }

  function versionStratigraphy(targetPath) {
    const relativeVersion = ".agent/skills/iterative-planner/config/version.json";
    const committed = plannerVersionFromText(gitText(targetPath, ["show", `HEAD:${relativeVersion}`]));
    let tree = "unknown";
    const skillPath = join(targetPath, ".agent/skills/iterative-planner/SKILL.md");
    const treePath = join(targetPath, relativeVersion);
    if (existsSync(treePath)) tree = plannerVersionFromText(readFileSync(treePath, "utf-8"));
    if (tree === "unknown" && existsSync(skillPath)) {
      tree = plannerVersionFromText(readFileSync(skillPath, "utf-8"));
    }
    let source = "unknown";
    const sourcePath = join(agentDir, "skills", "iterative-planner", "config", "version.json");
    if (existsSync(sourcePath)) source = plannerVersionFromText(readFileSync(sourcePath, "utf-8"));
    return { committed, tree, source };
  }

  function assessManagedSyncSafety(targetPath, staleEntries, removalPaths = []) {
    const candidates = [
      ...staleEntries.map((entry) => ({ path: entry.path, removal: false })),
      ...removalPaths.map((path) => ({ path, removal: true })),
    ];
    if (candidates.length === 0 || resolve(targetPath) === canonicalSourceProjectPath()) return { ok: true, conflicts: [] };

    const sourceRepo = canonicalSourceProjectPath();
    const sourceCommit = selectedSourceCommit();
    const sourceRef = selectedSourceRef();
    const targetGitRoot = gitText(targetPath, ["rev-parse", "--show-toplevel"]);
    const conflicts = [];
    if (!sourceCommit || !targetGitRoot || normalizeComparablePath(targetGitRoot) !== normalizeComparablePath(targetPath)) {
      for (const entry of candidates) {
        const targetRelativePath = gitPath(relative(targetPath, entry.path));
        const sourceRelativeToAgent = relative(join(targetPath, ".agent"), entry.path);
        const incomingPath = entry.removal ? null : join(agentDir, sourceRelativeToAgent);
        conflicts.push({
          path: targetRelativePath,
          classification: "unclassifiable_target",
          before_sha256: fileHash(entry.path),
          after_sha256: incomingPath ? fileHash(incomingPath) : null,
          diff_summary: boundedDiffSummary(incomingPath, entry.path),
        });
      }
      return {
        ok: false,
        conflicts,
        sourceRef,
        sourceCommit,
        targetPath,
        versionStratigraphy: versionStratigraphy(targetPath),
      };
    }

    const ancestryCache = new Map();
    const allHistoryCache = new Map();
    const selectedHistoryFor = (sourceRelativePath) => {
      let selectedIds = ancestryCache.get(sourceRelativePath);
      if (!selectedIds) {
        selectedIds = collectHistoricalBlobIds(sourceRepo, [sourceCommit], sourceRelativePath) || new Set();
        const selectedBlob = gitText(sourceRepo, ["rev-parse", "--verify", `${sourceCommit}:${sourceRelativePath}`]);
        if (selectedBlob) selectedIds.add(selectedBlob);
        for (const legacyBlob of legacyBlobIdsFor(sourceRelativePath)) selectedIds.add(legacyBlob);
        ancestryCache.set(sourceRelativePath, selectedIds);
      }
      return selectedIds;
    };
    const allHistoryFor = (sourceRelativePath, selectedIds) => {
      let allIds = allHistoryCache.get(sourceRelativePath);
      if (!allIds) {
        allIds = collectHistoricalBlobIds(sourceRepo, ["--all"], sourceRelativePath) || new Set();
        for (const oid of selectedIds) allIds.add(oid);
        allHistoryCache.set(sourceRelativePath, allIds);
      }
      return allIds;
    };
    const gitRoot = gitText(targetPath, ["rev-parse", "--show-toplevel"]);
    for (const entry of candidates) {
      const targetRelativePath = gitPath(relative(targetPath, entry.path));
      const sourceRelativeToAgent = relative(join(targetPath, ".agent"), entry.path);
      const incomingPath = entry.removal ? null : join(agentDir, sourceRelativeToAgent);
      const sourceRelativePath = gitPath(join(".agent", sourceRelativeToAgent));
      let gitRelPath = targetRelativePath;
      if (gitRoot) {
        try {
          const realEntryPath = existsSync(entry.path) ? realpathSync(entry.path) : entry.path;
          gitRelPath = gitPath(relative(gitRoot, realEntryPath));
        } catch {
          gitRelPath = targetRelativePath;
        }
      }
      const targetHeadBlob = gitText(targetPath, ["rev-parse", "--verify", `HEAD:${gitRelPath}`]);
      const targetWorkingBlob = existsSync(entry.path)
        ? gitText(targetPath, ["hash-object", "--", entry.path])
        : null;

      let classification = null;
      if (!targetWorkingBlob) classification = "unclassifiable_target";
      else if (!targetHeadBlob) {
        const selectedIds = selectedHistoryFor(sourceRelativePath);
        if (selectedIds.has(targetWorkingBlob)) continue;
        const allIds = allHistoryFor(sourceRelativePath, selectedIds);
        classification = allIds.has(targetWorkingBlob)
          ? "untracked_ahead_of_source_ref"
          : "unclassifiable_target";
      } else if (targetHeadBlob !== targetWorkingBlob) classification = "uncommitted_target";
      else {
        const selectedIds = selectedHistoryFor(sourceRelativePath);
        if (selectedIds.has(targetHeadBlob)) continue;

        const allIds = allHistoryFor(sourceRelativePath, selectedIds);
        classification = allIds.has(targetHeadBlob) ? "committed_ahead_of_source_ref" : "committed_divergence";
      }

      conflicts.push({
        path: targetRelativePath,
        classification,
        before_sha256: fileHash(entry.path),
        after_sha256: incomingPath ? fileHash(incomingPath) : null,
        target_head_blob: targetHeadBlob,
        target_working_blob: targetWorkingBlob,
        diff_summary: boundedDiffSummary(incomingPath, entry.path),
      });
    }
    return {
      ok: conflicts.length === 0,
      conflicts,
      sourceRef,
      sourceCommit,
      targetPath,
      versionStratigraphy: versionStratigraphy(targetPath),
    };
  }

  function printManagedSyncRefusal(report) {
    console.log("\n  ❌ MANAGED SYNC REFUSED — no managed files were written.");
    console.log(`  Source ref: ${report.sourceRef || selectedSourceRef()}`);
    console.log(`  Source commit: ${report.sourceCommit || "unresolved"}`);
    if (report.versionStratigraphy) {
      console.log(`  Version strata: committed=${report.versionStratigraphy.committed}, tree=${report.versionStratigraphy.tree}, source=${report.versionStratigraphy.source}`);
    }
    console.log(`  Conflicts: ${report.conflicts.length}`);
    for (const conflict of report.conflicts.slice(0, 25)) {
      console.log(`\n  - ${conflict.path}`);
      console.log(`    classification=${conflict.classification}`);
      console.log(`    before_sha256=${conflict.before_sha256 || "missing"}`);
      console.log(`    after_sha256=${conflict.after_sha256 || "missing"}`);
      console.log(`    Diff summary: ${conflict.diff_summary}`);
    }
    if (report.conflicts.length > 25) console.log(`\n  ... ${report.conflicts.length - 25} additional conflict(s) omitted.`);
    const sourcePin = report.sourceCommit || selectedSourceCommit() || selectedSourceRef();
    const sourceScript = join(
      canonicalSourceProjectPath(),
      ".agent/skills/iterative-planner/scripts/migrate.mjs",
    );
    console.log("\n  half-applied payload detected, or managed divergence requires review.");
    console.log("  Recovery: preserve unrelated work, then stash or revert .agent/** and managed root snapshots to committed state.");
    console.log(`  Rerun: node ${JSON.stringify(sourceScript)} upgrade ${JSON.stringify(report.targetPath || "<target-path>")} --source-ref ${sourcePin} --commit`);
    console.log("  If doctor reports an active transaction, run its recover-upgrade command first. No force-overwrite path is available.\n");
  }

  return {
    assessManagedSyncSafety,
    canonicalSourceProjectPath,
    gitPath,
    managedDisplayPath,
    printManagedSyncRefusal,
    runFromPinnedSourceSnapshot,
    selectedSourceCommit,
    selectedSourceRef,
    sourcePathHasHistory,
  };
}
