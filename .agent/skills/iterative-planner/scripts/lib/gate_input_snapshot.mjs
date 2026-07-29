// gate_input_snapshot.mjs - immutable gate-time plan input capture for lifecycle replay.
// @planner:module = gate_input_snapshot
// @planner:capability = content_hashed_gate_time_replay_input
// @planner:story = US-073, US-086
// @planner:proves = sc_1, sc_2, sc_3

import { createHash } from "crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join, relative, resolve, sep } from "path";

export const GATE_INPUT_SNAPSHOT_SCHEMA_VERSION = 1;
const SNAPSHOT_ROOT = join("artifacts", "gate_input_snapshots");
const SUPPORTED_GATES = new Set(["plan-to-execute"]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function isContained(parent, candidate) {
  const root = resolve(parent);
  const target = resolve(candidate);
  return target === root || target.startsWith(`${root}${sep}`);
}

function safeTimestamp(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`capturedAt must be an ISO8601 timestamp; received ${value}`);
  return parsed.toISOString().replace(/[:.]/g, "-");
}

function assertSupportedGate(gate) {
  if (!SUPPORTED_GATES.has(gate)) throw new Error(`unsupported gate-input snapshot gate: ${gate || "(blank)"}`);
}

function pointerPathFor(planDir, gate) {
  return join(resolve(planDir), SNAPSHOT_ROOT, `latest_${gate}.json`);
}

function readJson(path, label, errors) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

function invalidResult({ planDir, gate, pointerPath, snapshotPath = null, manifestPath = null, errors }) {
  return {
    status: "invalid",
    gate,
    plan_dir: resolve(planDir),
    path: snapshotPath,
    pointer_path: pointerPath,
    manifest_path: manifestPath,
    manifest: null,
    artifact_paths: [pointerPath, manifestPath].filter(Boolean),
    errors,
  };
}

export function prepareGateInputSnapshot({ planDir, gate, capturedAt = new Date().toISOString() } = {}) {
  assertSupportedGate(gate);
  const sourcePlanDir = resolve(planDir);
  if (!existsSync(sourcePlanDir)) throw new Error(`plan directory does not exist: ${sourcePlanDir}`);
  const files = readdirSync(sourcePlanDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) throw new Error(`plan directory has no top-level regular files: ${sourcePlanDir}`);

  const capturedFiles = files.map((path) => {
    const bytes = readFileSync(join(sourcePlanDir, path));
    return {
      path,
      bytes,
      size: bytes.length,
      sha256: sha256(bytes),
    };
  });
  const normalizedCapturedAt = new Date(capturedAt).toISOString();
  const snapshotName = `${safeTimestamp(capturedAt)}_${gate}`;
  const manifest = {
    schema_version: GATE_INPUT_SNAPSHOT_SCHEMA_VERSION,
    gate,
    captured_at: normalizedCapturedAt,
    source_plan: basename(sourcePlanDir),
    file_count: capturedFiles.length,
    files: capturedFiles.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest })),
  };
  return {
    schema_version: GATE_INPUT_SNAPSHOT_SCHEMA_VERSION,
    gate,
    plan_dir: sourcePlanDir,
    snapshot_name: snapshotName,
    files: capturedFiles,
    manifest,
    manifest_bytes: jsonBytes(manifest),
  };
}

export function persistGateInputSnapshot(prepared) {
  assertSupportedGate(prepared?.gate);
  if (prepared?.schema_version !== GATE_INPUT_SNAPSHOT_SCHEMA_VERSION || !Array.isArray(prepared?.files)) {
    throw new Error("invalid prepared gate-input snapshot");
  }
  const planDir = resolve(prepared.plan_dir);
  const root = join(planDir, SNAPSHOT_ROOT);
  const snapshotPath = join(root, prepared.snapshot_name);
  const pointerPath = pointerPathFor(planDir, prepared.gate);
  const pendingPath = join(root, `.pending-${prepared.snapshot_name}-${process.pid}`);
  if (basename(String(prepared.snapshot_name || "")) !== prepared.snapshot_name) {
    throw new Error("prepared snapshot_name must be one directory name");
  }
  for (const file of prepared.files) {
    if (typeof file?.path !== "string" || basename(file.path) !== file.path || !Buffer.isBuffer(file.bytes)) {
      throw new Error(`invalid prepared snapshot file: ${file?.path || "(blank)"}`);
    }
  }
  if (!isContained(root, snapshotPath) || dirname(snapshotPath) !== resolve(root)) {
    throw new Error("snapshot directory escapes the owning plan");
  }
  if (existsSync(snapshotPath)) throw new Error(`gate-input snapshot already exists: ${snapshotPath}`);
  if (existsSync(pointerPath)) throw new Error(`gate-input snapshot pointer already exists: ${pointerPath}`);

  let snapshotPublished = false;
  let pointerPending = null;
  try {
    mkdirSync(root, { recursive: true });
    if (!lstatSync(root).isDirectory()) throw new Error("gate-input snapshot root must be a regular directory");
    mkdirSync(pendingPath);
    for (const file of prepared.files) writeFileSync(join(pendingPath, file.path), file.bytes);
    writeFileSync(join(pendingPath, "manifest.json"), prepared.manifest_bytes);
    renameSync(pendingPath, snapshotPath);
    snapshotPublished = true;

    const pointer = {
      schema_version: GATE_INPUT_SNAPSHOT_SCHEMA_VERSION,
      gate: prepared.gate,
      snapshot_dir: prepared.snapshot_name,
      manifest_sha256: sha256(prepared.manifest_bytes),
    };
    pointerPending = `${pointerPath}.pending-${process.pid}`;
    writeFileSync(pointerPending, jsonBytes(pointer));
    renameSync(pointerPending, pointerPath);
  } catch (error) {
    if (pointerPending) rmSync(pointerPending, { force: true });
    rmSync(pendingPath, { recursive: true, force: true });
    if (snapshotPublished) rmSync(snapshotPath, { recursive: true, force: true });
    throw error;
  }

  const resolved = resolveGateInputSnapshot({ planDir, gate: prepared.gate });
  if (resolved.status !== "valid") {
    removeGateInputSnapshot({ ...resolved, path: snapshotPath, pointer_path: pointerPath });
    throw new Error(`persisted gate-input snapshot failed validation: ${(resolved.errors || []).join("; ")}`);
  }
  return resolved;
}

export function captureGateInputSnapshot(options = {}) {
  return persistGateInputSnapshot(prepareGateInputSnapshot(options));
}

export function removeGateInputSnapshot(snapshot) {
  const planDir = resolve(snapshot?.plan_dir || snapshot?.manifest?.source_plan || ".");
  const root = join(planDir, SNAPSHOT_ROOT);
  const snapshotPath = snapshot?.path ? resolve(snapshot.path) : null;
  const pointerPath = snapshot?.pointer_path ? resolve(snapshot.pointer_path) : null;
  if (snapshotPath && isContained(root, snapshotPath) && dirname(snapshotPath) === resolve(root)) {
    rmSync(snapshotPath, { recursive: true, force: true });
  }
  if (pointerPath && pointerPath === resolve(pointerPathFor(planDir, snapshot?.gate))) {
    rmSync(pointerPath, { force: true });
  }
}

export function resolveGateInputSnapshot({ planDir, gate } = {}) {
  const sourcePlanDir = resolve(planDir);
  const root = join(sourcePlanDir, SNAPSHOT_ROOT);
  const pointerPath = pointerPathFor(sourcePlanDir, gate);
  if (!SUPPORTED_GATES.has(gate)) {
    return invalidResult({ planDir: sourcePlanDir, gate, pointerPath, errors: [`unsupported gate-input snapshot gate: ${gate || "(blank)"}`] });
  }
  if (existsSync(root) && !lstatSync(root).isDirectory()) {
    return invalidResult({ planDir: sourcePlanDir, gate, pointerPath, errors: ["gate-input snapshot root must be a regular directory"] });
  }
  if (!existsSync(pointerPath)) {
    return {
      status: "absent",
      gate,
      plan_dir: sourcePlanDir,
      path: null,
      pointer_path: pointerPath,
      manifest_path: null,
      manifest: null,
      artifact_paths: [],
      errors: [],
    };
  }

  const errors = [];
  if (!lstatSync(pointerPath).isFile()) {
    errors.push("snapshot pointer must be a regular file");
    return invalidResult({ planDir: sourcePlanDir, gate, pointerPath, errors });
  }
  const pointer = readJson(pointerPath, "snapshot pointer", errors);
  if (!pointer) return invalidResult({ planDir: sourcePlanDir, gate, pointerPath, errors });
  if (pointer.schema_version !== GATE_INPUT_SNAPSHOT_SCHEMA_VERSION) errors.push(`snapshot pointer schema_version must be ${GATE_INPUT_SNAPSHOT_SCHEMA_VERSION}`);
  if (pointer.gate !== gate) errors.push(`snapshot pointer gate must be ${gate}`);
  if (typeof pointer.snapshot_dir !== "string" || !pointer.snapshot_dir || basename(pointer.snapshot_dir) !== pointer.snapshot_dir || pointer.snapshot_dir === "." || pointer.snapshot_dir === "..") {
    errors.push("snapshot_dir must be one contained directory name");
  }
  if (!/^[a-f0-9]{64}$/.test(String(pointer.manifest_sha256 || ""))) errors.push("snapshot pointer manifest_sha256 must be a SHA-256 digest");
  if (errors.length > 0) return invalidResult({ planDir: sourcePlanDir, gate, pointerPath, errors });

  const snapshotPath = resolve(root, pointer.snapshot_dir);
  if (!isContained(root, snapshotPath) || dirname(snapshotPath) !== resolve(root)) {
    errors.push("snapshot_dir escapes the owning plan");
    return invalidResult({ planDir: sourcePlanDir, gate, pointerPath, snapshotPath, errors });
  }
  if (!existsSync(snapshotPath) || !lstatSync(snapshotPath).isDirectory()) {
    errors.push("snapshot_dir must resolve to a regular directory");
    return invalidResult({ planDir: sourcePlanDir, gate, pointerPath, snapshotPath, errors });
  }
  const manifestPath = join(snapshotPath, "manifest.json");
  if (!existsSync(manifestPath)) {
    errors.push("snapshot manifest.json is missing");
    return invalidResult({ planDir: sourcePlanDir, gate, pointerPath, snapshotPath, manifestPath, errors });
  }
  if (!lstatSync(manifestPath).isFile()) {
    errors.push("snapshot manifest must be a regular file");
    return invalidResult({ planDir: sourcePlanDir, gate, pointerPath, snapshotPath, manifestPath, errors });
  }
  const manifestBytes = readFileSync(manifestPath);
  if (sha256(manifestBytes) !== pointer.manifest_sha256) errors.push("snapshot manifest SHA-256 does not match the pointer");
  const manifest = readJson(manifestPath, "snapshot manifest", errors);
  if (!manifest) return invalidResult({ planDir: sourcePlanDir, gate, pointerPath, snapshotPath, manifestPath, errors });
  if (manifest.schema_version !== GATE_INPUT_SNAPSHOT_SCHEMA_VERSION) errors.push(`snapshot manifest schema_version must be ${GATE_INPUT_SNAPSHOT_SCHEMA_VERSION}`);
  if (manifest.gate !== gate) errors.push(`snapshot manifest gate must be ${gate}`);
  if (manifest.source_plan !== basename(sourcePlanDir)) errors.push(`snapshot manifest source_plan must be ${basename(sourcePlanDir)}`);
  if (Number.isNaN(Date.parse(manifest.captured_at))) errors.push("snapshot manifest captured_at must be ISO8601");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) errors.push("snapshot manifest files must be a non-empty array");
  if (manifest.file_count !== manifest.files?.length) errors.push("snapshot manifest file_count does not match files length");

  const listedNames = [];
  for (const file of Array.isArray(manifest.files) ? manifest.files : []) {
    if (typeof file?.path !== "string" || !file.path || basename(file.path) !== file.path || file.path === "manifest.json") {
      errors.push(`snapshot manifest file path is invalid: ${file?.path || "(blank)"}`);
      continue;
    }
    listedNames.push(file.path);
    const filePath = join(snapshotPath, file.path);
    if (!existsSync(filePath)) {
      errors.push(`snapshot file is missing: ${file.path}`);
      continue;
    }
    if (!lstatSync(filePath).isFile()) {
      errors.push(`snapshot entry must be a regular file: ${file.path}`);
      continue;
    }
    const bytes = readFileSync(filePath);
    if (bytes.length !== file.size) errors.push(`snapshot file size mismatch: ${file.path}`);
    if (sha256(bytes) !== file.sha256) errors.push(`snapshot file SHA-256 mismatch: ${file.path}`);
  }
  const uniqueSortedNames = [...new Set(listedNames)].sort();
  if (uniqueSortedNames.length !== listedNames.length || uniqueSortedNames.some((name, index) => name !== listedNames[index])) {
    errors.push("snapshot manifest file paths must be unique and sorted");
  }
  if (existsSync(snapshotPath)) {
    const actualEntries = readdirSync(snapshotPath, { withFileTypes: true });
    const nonFiles = actualEntries.filter((entry) => !entry.isFile()).map((entry) => entry.name);
    if (nonFiles.length > 0) errors.push(`snapshot contains non-file entries: ${nonFiles.sort().join(", ")}`);
    const actualNames = actualEntries.filter((entry) => entry.isFile() && entry.name !== "manifest.json").map((entry) => entry.name).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(uniqueSortedNames)) errors.push("snapshot file census does not match the manifest");
  }
  if (errors.length > 0) return invalidResult({ planDir: sourcePlanDir, gate, pointerPath, snapshotPath, manifestPath, errors });

  return {
    status: "valid",
    gate,
    plan_dir: sourcePlanDir,
    path: snapshotPath,
    pointer_path: pointerPath,
    manifest_path: manifestPath,
    manifest,
    artifact_paths: [
      pointerPath,
      manifestPath,
      ...manifest.files.map((file) => join(snapshotPath, file.path)),
    ],
    errors: [],
    relative_path: relative(sourcePlanDir, snapshotPath).replace(/\\/g, "/"),
  };
}
