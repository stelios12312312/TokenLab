#!/usr/bin/env node
// clean_checkout_conformance.mjs — Replay release-health consumers at one immutable revision.
// @planner:module clean_checkout_conformance
// @planner:capability detached_revision_story_health_replay
// @planner:proves US-PM-AUTO-180

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import { verificationStatusIsPass } from "./lib/verification_status_vocabulary.mjs";

const NODE = process.execPath;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_BUFFER = 20 * 1024 * 1024;
const SCRIPT_ROOT = join(".agent", "skills", "iterative-planner", "scripts");
const PROBE_AUTHORITY_ENV_PREFIXES = Object.freeze([
  "_PLANNER_",
  "PLANNER_",
  "ITERATIVE_PLANNER_",
  "CLAUDE_CODE_",
  "CODEX_",
  "CURSOR_",
  "ANTIGRAVITY_",
]);
const PROBE_AUTHORITY_ENV_KEYS = Object.freeze([
  "GITHUB_REPOSITORY",
  "TERM_PROGRAM",
  "VSCODE_PID",
]);

function parseArgs(argv = []) {
  const parsed = {
    repo: process.cwd(),
    ref: "HEAD",
    output: null,
    profileManifest: null,
    requireProfile: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--repo") parsed.repo = argv[++index];
    else if (arg.startsWith("--repo=")) parsed.repo = arg.slice("--repo=".length);
    else if (arg === "--ref") parsed.ref = argv[++index];
    else if (arg.startsWith("--ref=")) parsed.ref = arg.slice("--ref=".length);
    else if (arg === "--output") parsed.output = argv[++index];
    else if (arg.startsWith("--output=")) parsed.output = arg.slice("--output=".length);
    else if (arg === "--profile-manifest") parsed.profileManifest = argv[++index];
    else if (arg.startsWith("--profile-manifest=")) parsed.profileManifest = arg.slice("--profile-manifest=".length);
    else if (arg === "--require-profile") parsed.requireProfile = argv[++index];
    else if (arg.startsWith("--require-profile=")) parsed.requireProfile = arg.slice("--require-profile=".length);
    else if (arg === "--timeout-ms") parsed.timeoutMs = Number.parseInt(argv[++index] || "", 10);
    else if (arg.startsWith("--timeout-ms=")) parsed.timeoutMs = Number.parseInt(arg.slice("--timeout-ms=".length), 10);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!parsed.repo) throw new Error("--repo requires a path");
  if (!parsed.ref) throw new Error("--ref requires a value");
  if (Boolean(parsed.profileManifest) !== Boolean(parsed.requireProfile)) {
    throw new Error("--profile-manifest and --require-profile must be provided together");
  }
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  return parsed;
}

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/clean_checkout_conformance.mjs [--repo <path>] [--ref <revision>] [--output <repo-relative-json>] [--profile-manifest <repo-relative-json>] [--require-profile <id>] [--timeout-ms <ms>] [--json]`;
}

function excerpt(value, limit = 1000) {
  const text = String(value || "").trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function parseJsonOutput(stdout) {
  const text = String(stdout || "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) {
    return { payload: null, error: "stdout did not contain a JSON object" };
  }
  try {
    return { payload: JSON.parse(text.slice(start, end + 1)), error: null };
  } catch (error) {
    return { payload: null, error: `invalid JSON output: ${error.message}` };
  }
}

function runFile(command, args, options = {}) {
  const started = Date.now();
  let stdoutFd = null;
  let result;
  try {
    if (options.stdoutPath) stdoutFd = openSync(options.stdoutPath, "w");
    result = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      encoding: "utf8",
      timeout: options.timeoutMs,
      maxBuffer: MAX_BUFFER,
      stdio: stdoutFd === null ? undefined : ["ignore", stdoutFd, "pipe"],
    });
  } finally {
    if (stdoutFd !== null) closeSync(stdoutFd);
  }
  return {
    exit_code: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal || null,
    timed_out: result.error?.code === "ETIMEDOUT",
    error: result.error ? result.error.message : null,
    stdout: options.stdoutPath ? readFileSync(options.stdoutPath, "utf8") : result.stdout || "",
    stderr: result.stderr || "",
    duration_ms: Date.now() - started,
  };
}

function isolatedGitEnvironment(baseEnv = process.env) {
  const env = { ...(baseEnv || {}) };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

function git(repoRoot, args, timeoutMs) {
  return runFile("git", args, {
    cwd: repoRoot,
    env: isolatedGitEnvironment(),
    timeoutMs,
  });
}

function cleanText(value, paths) {
  let result = String(value || "");
  for (const [path, label] of paths) {
    if (path) result = result.split(path).join(label);
  }
  return result;
}

function publicFailure(result, paths) {
  return {
    exit_code: result.exit_code,
    signal: result.signal,
    timed_out: result.timed_out,
    error: cleanText(result.error, paths) || null,
    stdout_excerpt: excerpt(cleanText(result.stdout, paths)) || null,
    stderr_excerpt: excerpt(cleanText(result.stderr, paths)) || null,
  };
}

function resolveOutputPath(repoRoot, output) {
  if (!output) return null;
  if (isAbsolute(output)) throw new Error("--output must be repository-relative");
  const target = resolve(repoRoot, output);
  const rel = relative(repoRoot, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("--output must resolve to a file inside --repo");
  }
  return target;
}

function resolveRepoFile(repoRoot, filePath, flagName) {
  if (!filePath) return null;
  if (isAbsolute(filePath)) throw new Error(`${flagName} must be repository-relative`);
  const target = resolve(repoRoot, filePath);
  const rel = relative(repoRoot, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${flagName} must resolve to a file inside --repo`);
  }
  return { absolute: target, relative: rel.replaceAll("\\", "/") };
}

function summarizeGovernedProfileManifest({
  repoRoot,
  profileManifest,
  requireProfile,
  targetSha,
}) {
  let resolvedManifest;
  try {
    resolvedManifest = resolveRepoFile(repoRoot, profileManifest, "--profile-manifest");
  } catch (error) {
    return {
      status: "FAIL",
      profile_id: requireProfile || null,
      manifest_path: profileManifest || null,
      manifest_sha256: null,
      target_sha: targetSha,
      errors: [error.message],
    };
  }
  if (!resolvedManifest || !existsSync(resolvedManifest.absolute)) {
    return {
      status: "FAIL",
      profile_id: requireProfile || null,
      manifest_path: resolvedManifest?.relative || profileManifest || null,
      manifest_sha256: null,
      target_sha: targetSha,
      errors: ["profile manifest does not exist"],
    };
  }

  const raw = readFileSync(resolvedManifest.absolute);
  const manifestSha256 = createHash("sha256").update(raw).digest("hex");
  let manifest;
  try {
    manifest = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    return {
      status: "FAIL",
      profile_id: requireProfile || null,
      manifest_path: resolvedManifest.relative,
      manifest_sha256: manifestSha256,
      target_sha: targetSha,
      errors: [`invalid profile manifest JSON: ${error.message}`],
    };
  }

  const errors = [];
  const profile = manifest?.profile;
  const suites = Array.isArray(manifest?.suites) ? manifest.suites : [];
  const selectedIds = Array.isArray(profile?.selected_suite_ids) ? profile.selected_suite_ids : [];
  const suiteIds = suites.map((suite) => suite?.id).filter(Boolean);
  if (profile?.id !== requireProfile) {
    errors.push(`expected profile ${requireProfile}, received ${profile?.id || "none"}`);
  }
  if (!verificationStatusIsPass(manifest?.overall_status, "execution")) errors.push("overall_status must be pass");
  if (!manifest?.summary || Number(manifest.summary.failed) !== 0) errors.push("summary.failed must be 0");
  for (const field of ["warned", "skipped", "not_applicable", "not_implemented"]) {
    if (Number(manifest?.summary?.[field] || 0) !== 0) errors.push(`summary.${field} must be 0`);
  }
  if (suites.length === 0) errors.push("manifest must contain at least one selected suite");
  if (suites.some((suite) => !verificationStatusIsPass(suite?.status, "execution") || suite?.required === false)) {
    errors.push("every selected suite must be required and pass");
  }
  if (
    selectedIds.length !== suiteIds.length
    || selectedIds.some((suiteId, index) => suiteId !== suiteIds[index])
  ) {
    errors.push("profile selected_suite_ids must exactly match manifest suites");
  }
  const partitionCount = Number(profile?.selected_suite_count || 0)
    + Number(profile?.explicit_exclusion_count || 0)
    + Number(profile?.omitted_by_rule_count || 0);
  if (
    !Number.isInteger(profile?.catalog_suite_count)
    || partitionCount !== profile.catalog_suite_count
  ) {
    errors.push("profile suite partition must cover the catalog");
  }
  if (manifest?.repo_state_stamp?.head_sha !== targetSha) {
    errors.push("profile manifest repo_state_stamp.head_sha must equal target_sha");
  }
  if (manifest?.repo_state_stamp?.dirty !== false) {
    errors.push("profile manifest repo_state_stamp must be clean");
  }
  if (Array.isArray(manifest?.issues) && manifest.issues.length > 0) {
    errors.push("profile manifest must not contain issues");
  }

  return {
    status: errors.length === 0 ? "PASS" : "FAIL",
    profile_id: profile?.id || null,
    manifest_path: resolvedManifest.relative,
    manifest_sha256: manifestSha256,
    target_sha: targetSha,
    selected_suite_count: suites.length,
    errors,
  };
}

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isolatedProbeEnvironment(baseEnv = process.env) {
  const env = isolatedGitEnvironment(baseEnv);
  for (const key of Object.keys(env)) {
    if (
      PROBE_AUTHORITY_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
      || PROBE_AUTHORITY_ENV_KEYS.includes(key)
    ) {
      env[key] = "";
    }
  }
  env.PLANNER_SKIP_SELF_HEAL = "1";
  return env;
}

function probe(checkoutRoot, definition, timeoutMs, paths) {
  const script = join(checkoutRoot, SCRIPT_ROOT, definition.script);
  const stdoutPath = join(dirname(checkoutRoot), `${definition.script}.stdout.json`);
  const env = isolatedProbeEnvironment();
  const result = runFile(NODE, [script, ...definition.args], {
    cwd: checkoutRoot,
    env,
    timeoutMs,
    stdoutPath,
  });
  const parsed = parseJsonOutput(result.stdout);
  return {
    result,
    payload: parsed.payload,
    parse_error: parsed.error,
    failure: publicFailure(result, paths),
  };
}

function summarizeCanonical(probeResult) {
  const errors = Array.isArray(probeResult.payload?.errors) ? probeResult.payload.errors : [];
  const warnings = Array.isArray(probeResult.payload?.warnings) ? probeResult.payload.warnings : [];
  const pass = probeResult.result.exit_code === 0
    && !probeResult.parse_error
    && verificationStatusIsPass(probeResult.payload?.status, "gate")
    && errors.length === 0;
  return {
    status: pass ? "PASS" : "FAIL",
    error_count: errors.length,
    warning_count: warnings.length,
    errors,
    duration_ms: probeResult.result.duration_ms,
    parse_error: probeResult.parse_error,
    ...probeResult.failure,
  };
}

function summarizeInvariants(probeResult) {
  const violations = Array.isArray(probeResult.payload?.violations)
    ? probeResult.payload.violations
    : [];
  const violationCount = Number.isFinite(probeResult.payload?.count)
    ? probeResult.payload.count
    : violations.length;
  const pass = probeResult.result.exit_code === 0
    && !probeResult.parse_error
    && verificationStatusIsPass(probeResult.payload?.status, "gate")
    && violationCount === 0;
  return {
    status: pass ? "PASS" : "FAIL",
    violation_count: violationCount,
    warning_count: Number(probeResult.payload?.warning_count || probeResult.payload?.warnings?.length || 0),
    violations,
    duration_ms: probeResult.result.duration_ms,
    parse_error: probeResult.parse_error,
    ...probeResult.failure,
  };
}

function bridgeDisagreementCount(bridge, canonical, invariants) {
  const explicit = bridge?.canonical_health_disagreement_count ?? bridge?.disagreement_count;
  const explicitCount = Number.isFinite(explicit) ? explicit : 0;
  if (canonical.status !== invariants.status) {
    return Math.max(explicitCount, canonical.error_count || 0, invariants.violation_count || 0, 1);
  }
  return explicitCount;
}

function summarizeFindings(probeResult, canonical, invariants) {
  const bridge = probeResult.payload?.iv_consistency_bridge || null;
  const disagreementCount = bridgeDisagreementCount(bridge, canonical, invariants);
  const bridgeCanonical = bridge?.canonical_story_registry?.status || null;
  const bridgeInvariant = bridge?.invariant_only?.status || null;
  const agrees = bridge
    && bridgeCanonical === canonical.status
    && bridgeInvariant === invariants.status;
  const pass = probeResult.result.exit_code === 0
    && !probeResult.parse_error
    && agrees
    && disagreementCount === 0
    && verificationStatusIsPass(bridge.status, "gate");
  return {
    status: pass ? "PASS" : "FAIL",
    bridge_status: bridge?.status || null,
    canonical_status: bridgeCanonical,
    invariant_status: bridgeInvariant,
    disagreement_count: disagreementCount,
    advisories: Array.isArray(bridge?.advisories) ? bridge.advisories : [],
    duration_ms: probeResult.result.duration_ms,
    parse_error: probeResult.parse_error,
    ...probeResult.failure,
  };
}

function summarizeHealth(probeResult) {
  const failCount = Number(probeResult.payload?.summary?.fail ?? Number.NaN);
  const pass = probeResult.result.exit_code === 0
    && !probeResult.parse_error
    && Number.isFinite(failCount)
    && failCount === 0;
  return {
    status: pass ? "PASS" : "FAIL",
    fail_count: Number.isFinite(failCount) ? failCount : null,
    warn_count: Number(probeResult.payload?.summary?.warn || 0),
    info_count: Number(probeResult.payload?.summary?.info || 0),
    duration_ms: probeResult.result.duration_ms,
    parse_error: probeResult.parse_error,
    ...probeResult.failure,
  };
}

function writeReceipt(receipt, outputPath) {
  if (!outputPath) return;
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
}

function failedReceipt({ requestedRef, startedAt, stage, detail = null, governedProfile = null }) {
  return {
    schema_version: 1,
    check: "clean-checkout-conformance",
    status: "FAIL",
    release_authority: false,
    repository: ".",
    requested_ref: requestedRef,
    target_sha: null,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    failure_stage: stage,
    failure: detail,
    checks: {},
    governed_profile: governedProfile,
    iv_consistency: {
      canonical_status: null,
      invariant_status: null,
      disagreement_count: null,
      disagreement: null,
    },
    post_run_clean: null,
    cleanup: { status: "PASS", worktree_removed: false, pruned: false, errors: [] },
  };
}

function runCleanCheckoutConformance(options = {}) {
  const repoRoot = canonicalPath(resolve(options.repo || process.cwd()));
  const requestedRef = options.ref || "HEAD";
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const startedAt = new Date().toISOString();
  let outputPath;
  try {
    outputPath = resolveOutputPath(repoRoot, options.output || null);
  } catch (error) {
    return failedReceipt({ requestedRef, startedAt, stage: "validate_output", detail: error.message });
  }

  const topLevel = git(repoRoot, ["rev-parse", "--show-toplevel"], timeoutMs);
  if (topLevel.exit_code !== 0 || canonicalPath(topLevel.stdout.trim() || repoRoot) !== repoRoot) {
    const receipt = failedReceipt({
      requestedRef,
      startedAt,
      stage: "validate_repo",
      detail: excerpt(topLevel.stderr || topLevel.error || "not a Git worktree root"),
    });
    writeReceipt(receipt, outputPath);
    return receipt;
  }

  const resolvedRef = git(repoRoot, ["rev-parse", "--verify", `${requestedRef}^{commit}`], timeoutMs);
  const targetSha = resolvedRef.stdout.trim();
  if (resolvedRef.exit_code !== 0 || !/^[0-9a-f]{40,64}$/i.test(targetSha)) {
    const receipt = failedReceipt({
      requestedRef,
      startedAt,
      stage: "resolve_ref",
      detail: excerpt(resolvedRef.stderr || resolvedRef.error || "revision did not resolve to a commit"),
    });
    writeReceipt(receipt, outputPath);
    return receipt;
  }

  const governedProfile = options.profileManifest
    ? summarizeGovernedProfileManifest({
      repoRoot,
      profileManifest: options.profileManifest,
      requireProfile: options.requireProfile,
      targetSha,
    })
    : null;
  if (governedProfile && !verificationStatusIsPass(governedProfile.status, "gate")) {
    const receipt = failedReceipt({
      requestedRef,
      startedAt,
      stage: "governed_profile_manifest",
      detail: governedProfile.errors.join("; "),
      governedProfile,
    });
    receipt.target_sha = targetSha;
    receipt.checks.governed_profile = governedProfile;
    writeReceipt(receipt, outputPath);
    return receipt;
  }

  const tempRoot = mkdtempSync(join(canonicalPath(tmpdir()), "ive-clean-checkout-"));
  const checkoutRoot = join(tempRoot, "checkout");
  const paths = [[checkoutRoot, "<checkout>"], [repoRoot, "<repo>"], [tempRoot, "<temp>"]];
  const cleanup = { status: "PASS", worktree_removed: false, pruned: false, errors: [] };
  let receipt;

  try {
    const added = git(repoRoot, ["worktree", "add", "--detach", checkoutRoot, targetSha], timeoutMs);
    if (added.exit_code !== 0) {
      receipt = failedReceipt({
        requestedRef,
        startedAt,
        stage: "create_worktree",
        detail: cleanText(added.stderr || added.error, paths),
      });
      receipt.target_sha = targetSha;
    } else {
      const canonicalProbe = probe(checkoutRoot, {
        script: "story_registry.mjs",
        args: ["check", "--json"],
      }, timeoutMs, paths);
      const invariantProbe = probe(checkoutRoot, {
        script: "rule_engine.mjs",
        args: ["check-invariants", "--json"],
      }, timeoutMs, paths);
      const canonical = summarizeCanonical(canonicalProbe);
      const invariants = summarizeInvariants(invariantProbe);
      const findingsProbe = probe(checkoutRoot, {
        script: "planner_findings.mjs",
        args: ["--json"],
      }, timeoutMs, paths);
      const findings = summarizeFindings(findingsProbe, canonical, invariants);
      const healthProbe = probe(checkoutRoot, {
        script: "project_health.mjs",
        args: ["--quick", "--json"],
      }, timeoutMs, paths);
      const health = summarizeHealth(healthProbe);
      const statusProbe = git(repoRoot, [
        "-C",
        checkoutRoot,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignored=matching",
      ], timeoutMs);
      const postRunClean = statusProbe.exit_code === 0 && statusProbe.stdout.trim() === "";
      const disagreementCount = findings.disagreement_count;
      const checks = {
        canonical_story_registry: canonical,
        ontology_invariants: invariants,
        planner_findings: findings,
        project_health: health,
        ...(governedProfile ? { governed_profile: governedProfile } : {}),
      };
      const probesPass = Object.values(checks)
        .every((check) => verificationStatusIsPass(check.status, "gate"));
      const conformancePassed = probesPass && postRunClean;

      receipt = {
        schema_version: 1,
        check: "clean-checkout-conformance",
        status: conformancePassed ? "PASS" : "FAIL",
        release_authority: Boolean(governedProfile) && conformancePassed,
        repository: ".",
        requested_ref: requestedRef,
        target_sha: targetSha,
        started_at: startedAt,
        finished_at: null,
        failure_stage: probesPass && postRunClean ? null : postRunClean ? "probe_verdict" : "post_run_cleanliness",
        checks,
        governed_profile: governedProfile,
        iv_consistency: {
          canonical_status: canonical.status,
          invariant_status: invariants.status,
          disagreement_count: disagreementCount,
          disagreement: disagreementCount > 0 || canonical.status !== invariants.status,
        },
        post_run_clean: postRunClean,
        post_run_status_excerpt: excerpt(cleanText(statusProbe.stdout || statusProbe.stderr, paths)) || null,
        cleanup,
      };
    }
  } finally {
    const removed = git(repoRoot, ["worktree", "remove", "--force", checkoutRoot], timeoutMs);
    if (removed.exit_code === 0) cleanup.worktree_removed = true;
    else if (receipt?.failure_stage !== "create_worktree") {
      cleanup.errors.push(excerpt(cleanText(removed.stderr || removed.error, paths)));
    }
    const pruned = git(repoRoot, ["worktree", "prune"], timeoutMs);
    cleanup.pruned = pruned.exit_code === 0;
    if (pruned.exit_code !== 0) cleanup.errors.push(excerpt(cleanText(pruned.stderr || pruned.error, paths)));
    rmSync(tempRoot, { recursive: true, force: true });
    cleanup.status = cleanup.errors.length === 0 ? "PASS" : "FAIL";
  }

  receipt.cleanup = cleanup;
  if (!verificationStatusIsPass(cleanup.status, "gate")) {
    receipt.status = "FAIL";
    receipt.failure_stage ||= "cleanup";
  }
  receipt.release_authority = Boolean(receipt.governed_profile)
    && verificationStatusIsPass(receipt.status, "gate");
  receipt.finished_at = new Date().toISOString();
  writeReceipt(receipt, outputPath);
  return receipt;
}

function printText(receipt) {
  console.log(`Clean checkout conformance: ${receipt.status}`);
  if (!receipt.governed_profile) {
    console.log("  NOT-RELEASE-AUTHORITY: no governed profile manifest is bound to this run.");
  }
  console.log(`  ref:    ${receipt.requested_ref}`);
  console.log(`  commit: ${receipt.target_sha || "unresolved"}`);
  if (receipt.failure_stage) console.log(`  failure stage: ${receipt.failure_stage}`);
}

function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const receipt = failedReceipt({
      requestedRef: null,
      startedAt: new Date().toISOString(),
      stage: "parse_args",
      detail: error.message,
    });
    emitJson(receipt);
    return 2;
  }
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const receipt = runCleanCheckoutConformance(args);
  if (args.json) emitJson(receipt);
  else printText(receipt);
  return verificationStatusIsPass(receipt.status, "gate") ? 0 : 1;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}

export {
  parseArgs,
  runCleanCheckoutConformance,
};
