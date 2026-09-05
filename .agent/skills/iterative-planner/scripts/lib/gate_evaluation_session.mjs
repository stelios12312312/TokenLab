// gate_evaluation_session.mjs — exact, short-lived dry-run handoff for transitions.

import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { spawnSync } from "child_process";
import { verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

export const GATE_EVALUATION_SESSION_VERSION = 1;
export const DEFAULT_GATE_EVALUATION_TTL_MS = 120_000;
export const DEFAULT_GATE_EVALUATION_RETENTION = 8;

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : stableStringify(value)).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function safeSegment(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function runGit(projectRoot, args) {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf-8",
    timeout: 15_000,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  return result.status === 0 ? String(result.stdout || "") : "";
}

function hashFiles(root, paths) {
  const hash = createHash("sha256");
  for (const path of [...new Set(paths)].sort()) {
    const full = isAbsolute(path) ? path : join(root, path);
    if (!existsSync(full)) {
      hash.update(`M\0${relative(root, full)}\0`);
      continue;
    }
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    hash.update(`F\0${relative(root, full).replace(/\\/g, "/")}\0`);
    hash.update(readFileSync(full));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function walkFiles(root, { exclude = [] } = {}) {
  const output = [];
  const visit = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).replace(/\\/g, "/");
      if (exclude.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) output.push(rel);
    }
  };
  visit(root);
  return output;
}

function gitState(projectRoot) {
  const head = runGit(projectRoot, ["rev-parse", "HEAD"]).trim() || "UNBORN";
  const index = sha256(runGit(projectRoot, ["diff", "--cached", "--binary", "--no-ext-diff"]));
  const unstaged = sha256(runGit(projectRoot, ["diff", "--binary", "--no-ext-diff"]));
  const untrackedPaths = runGit(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .filter((path) => path !== "state.json.lock" && !path.endsWith("/state.json.lock"))
    .sort();
  const untrackedHash = createHash("sha256");
  for (const path of untrackedPaths) {
    untrackedHash.update(`${path}\0`);
    try { untrackedHash.update(readFileSync(join(projectRoot, path))); } catch { untrackedHash.update("UNREADABLE"); }
    untrackedHash.update("\0");
  }
  return { head, index, unstaged, untracked: untrackedHash.digest("hex") };
}

function bundleDigest(skillPath, roots) {
  const paths = [];
  for (const root of roots) {
    const absolute = join(skillPath, root);
    if (!existsSync(absolute)) continue;
    const stat = statSync(absolute);
    if (stat.isFile()) paths.push(relative(skillPath, absolute));
    else paths.push(...walkFiles(absolute).map((path) => join(root, path)));
  }
  return hashFiles(skillPath, paths);
}

export function buildGateEvaluationIdentity({
  projectRoot = process.cwd(),
  planDir,
  planId = basename(planDir || "unknown"),
  gate,
  sourceState,
  skillPath = join(projectRoot, ".agent", "skills", "iterative-planner"),
  evaluatorContract = null,
} = {}) {
  const planFiles = walkFiles(planDir, {
    // Planner-owned synchronization/telemetry files are consequences of an
    // attempt, not gate authority. In particular, state.json.lock necessarily
    // exists during the under-lock identity recheck.
    exclude: ["artifacts/transition_receipts", "metrics.json", "state.json.lock"],
  }).map((path) => join(planDir, path));
  const evidencePaths = [
    join(projectRoot, "reports", "user_story_audit", "story_registry.json"),
    join(planDir, "verification.md"),
    join(planDir, "verification_ledger.json"),
    join(planDir, "red_team_notes.md"),
    join(planDir, "reflection.md"),
  ];
  const identity = {
    version: GATE_EVALUATION_SESSION_VERSION,
    plan_id: planId,
    gate,
    source_state: String(sourceState || "").toUpperCase() || null,
    plan_digest: hashFiles(projectRoot, planFiles),
    git: gitState(projectRoot),
    bundles: {
      evaluator: bundleDigest(skillPath, ["scripts/transition.mjs", "scripts/verify_gate.mjs", "scripts/lib"]),
      rules: bundleDigest(skillPath, ["prolog"]),
      config: bundleDigest(skillPath, ["config"]),
      checklists: bundleDigest(skillPath, ["checklists"]),
    },
    evidence_digest: hashFiles(projectRoot, evidencePaths),
    evaluator_contract_digest: sha256(evaluatorContract || {}),
  };
  return { ...identity, identity_digest: sha256(identity) };
}

function sessionIntegrityPayload(session) {
  const copy = structuredClone(session || {});
  delete copy.integrity_digest;
  return copy;
}

export function createGateEvaluationSessionReceipt({
  identity,
  gateReceipt,
  evaluationPayload = null,
  createdAt = new Date().toISOString(),
  ttlMs = DEFAULT_GATE_EVALUATION_TTL_MS,
} = {}) {
  const createdMs = Date.parse(createdAt);
  const session = {
    version: GATE_EVALUATION_SESSION_VERSION,
    created_at: createdAt,
    expires_at: new Date(createdMs + Math.max(1, Number(ttlMs) || DEFAULT_GATE_EVALUATION_TTL_MS)).toISOString(),
    identity: structuredClone(identity || {}),
    identity_digest: sha256(identity || {}),
    dry_run_status: String(gateReceipt?.status || "").toUpperCase() || null,
    gate_receipt: structuredClone(gateReceipt || null),
    evaluation_payload: evaluationPayload === undefined ? null : structuredClone(evaluationPayload),
  };
  session.integrity_digest = sha256(sessionIntegrityPayload(session));
  return session;
}

const IDENTITY_COMPARISONS = Object.freeze([
  ["plan_id", "target_plan_changed"],
  ["gate", "wrong_gate"],
  ["source_state", "source_state_changed"],
  ["plan_digest", "plan_changed"],
  ["git.head", "git_head_changed"],
  ["git.index", "git_index_changed"],
  ["git.unstaged", "git_unstaged_changed"],
  ["git.untracked", "git_untracked_changed"],
  ["bundles.evaluator", "evaluator_bundle_changed"],
  ["bundles.rules", "rule_bundle_changed"],
  ["bundles.config", "config_bundle_changed"],
  ["bundles.checklists", "checklist_bundle_changed"],
  ["evidence_digest", "evidence_changed"],
  ["evaluator_contract_digest", "evaluator_contract_changed"],
]);

function readKey(value, dotted) {
  return dotted.split(".").reduce((cursor, key) => cursor?.[key], value);
}

export function validateGateEvaluationSession({ session, identity, now = new Date().toISOString() } = {}) {
  if (!session || typeof session !== "object" || Number(session.version) !== GATE_EVALUATION_SESSION_VERSION) {
    return { reusable: false, reason: "corrupt_session" };
  }
  if (session.integrity_digest !== sha256(sessionIntegrityPayload(session))) {
    return { reusable: false, reason: "corrupt_session" };
  }
  if (session.identity_digest !== sha256(session.identity || {})) {
    return { reusable: false, reason: "corrupt_session" };
  }
  if (!verificationStatusIsPass(session.dry_run_status, "gate")
    || !verificationStatusIsPass(session.gate_receipt?.status, "gate")) {
    return { reusable: false, reason: "dry_run_not_passed" };
  }
  for (const [key, reason] of IDENTITY_COMPARISONS) {
    if (stableStringify(readKey(session.identity, key)) !== stableStringify(readKey(identity, key))) {
      return { reusable: false, reason, key };
    }
  }
  const nowMs = Date.parse(now);
  const expiresMs = Date.parse(session.expires_at);
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiresMs) || nowMs > expiresMs) {
    return { reusable: false, reason: "expired" };
  }
  return { reusable: true, reason: "exact_fresh_pass", identity_digest: session.identity_digest };
}

function gitDir(projectRoot) {
  const raw = runGit(projectRoot, ["rev-parse", "--git-common-dir"]).trim();
  if (!raw) return null;
  return isAbsolute(raw) ? raw : resolve(projectRoot, raw);
}

function sessionDir(projectRoot) {
  const dir = gitDir(projectRoot);
  return dir ? join(dir, "planner", "gate-evaluation-sessions") : null;
}

function latestSessionPath(projectRoot, planId, gate) {
  const root = sessionDir(projectRoot);
  return root ? join(root, safeSegment(planId), `latest_${safeSegment(gate)}.json`) : null;
}

export function writeGateEvaluationSession({ projectRoot = process.cwd(), planId, gate, session } = {}) {
  const latest = latestSessionPath(projectRoot, planId, gate);
  if (!latest) return { written: false, reason: "git_dir_unavailable", path: null };
  const dir = dirname(latest);
  mkdirSync(dir, { recursive: true });
  const stamp = safeSegment(session?.created_at || new Date().toISOString());
  const immutable = join(dir, `${stamp}_${safeSegment(gate)}.json`);
  const bytes = `${JSON.stringify(session, null, 2)}\n`;
  for (const path of [immutable, latest]) {
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, bytes);
    renameSync(temp, path);
  }
  const immutableFiles = readdirSync(dir)
    .filter((name) => name.endsWith(`_${safeSegment(gate)}.json`) && !name.startsWith("latest_"))
    .sort()
    .reverse();
  for (const stale of immutableFiles.slice(DEFAULT_GATE_EVALUATION_RETENTION)) {
    try { unlinkSync(join(dir, stale)); } catch { /* best effort */ }
  }
  return { written: true, reason: "committed", path: latest, immutable_path: immutable, bytes: Buffer.byteLength(bytes) };
}

export function readGateEvaluationSession({ projectRoot = process.cwd(), planId, gate } = {}) {
  const path = latestSessionPath(projectRoot, planId, gate);
  if (!path || !existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")); }
  catch { return null; }
}

export function classifyCheckDisposition({ definition, changedInputs = [], cachedResult = null } = {}) {
  if (!definition || typeof definition !== "object") {
    return { disposition: "ran", reason: "missing_or_malformed_definition" };
  }
  if (definition.applicability === false) {
    return { disposition: "not_applicable", reason: "explicit_applicability_false" };
  }
  const inputs = Array.isArray(definition.inputs) ? definition.inputs : null;
  if (!inputs) return { disposition: "ran", reason: "dependency_data_unknown" };
  if (inputs.some((input) => changedInputs.includes(input))) {
    return { disposition: "ran", reason: "declared_dependency_changed" };
  }
  if (definition.cacheable === true && String(cachedResult?.status || "").toUpperCase() === "PASS") {
    return { disposition: "reused", reason: "unchanged_cached_pass" };
  }
  return { disposition: "ran", reason: definition.cacheable === true ? "cached_pass_unavailable" : "not_cacheable" };
}
