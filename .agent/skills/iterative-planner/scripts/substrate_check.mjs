import { existsSync, readFileSync, readdirSync } from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join, relative } from "path";
import { verificationStatusIsPass } from "./lib/verification_status_vocabulary.mjs";

export const SEMANTIC_ROOT_RELATIVE_PATH = join(".agent", "semantic");
export const READINESS_RELATIVE_PATH = join(SEMANTIC_ROOT_RELATIVE_PATH, "readiness.yaml");
export const MUTEX_FACTS_RELATIVE_PATH = join(SEMANTIC_ROOT_RELATIVE_PATH, "mutex_facts.yaml");
export const POSTCONDITIONS_RELATIVE_PATH = join(SEMANTIC_ROOT_RELATIVE_PATH, "postconditions.yaml");
export const DOMAIN_CHECKLISTS_RELATIVE_PATH = join(SEMANTIC_ROOT_RELATIVE_PATH, "domain_checklists");

const SURFACE_ORDER = [
  "story_registry",
  "mutex_facts",
  "postconditions",
  "domain_checklists",
  "telemetry_capture",
];

const SURFACE_LABELS = Object.freeze({
  story_registry: "story registry",
  mutex_facts: "mutex facts",
  postconditions: "postconditions",
  domain_checklists: "domain checklists",
  telemetry_capture: "telemetry capture",
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function toRelative(projectRoot, targetPath) {
  return relative(projectRoot, targetPath).replace(/\\/g, "/") || ".";
}

function readJsonCompatibleYaml(filePath) {
  if (!existsSync(filePath)) {
    return {
      present: false,
      usable: false,
      parsed: null,
      error: "missing",
    };
  }

  try {
    const content = readFileSync(filePath, "utf-8").trim();
    if (!content) {
      return {
        present: true,
        usable: false,
        parsed: null,
        error: "empty",
      };
    }

    return {
      present: true,
      usable: true,
      parsed: JSON.parse(content),
      error: null,
    };
  } catch (error) {
    return {
      present: true,
      usable: false,
      parsed: null,
      error: error.message || "invalid_json_compatible_yaml",
    };
  }
}

function buildSurfaceIssue(surface, code, message, path = null) {
  return {
    surface,
    code,
    path,
    message,
  };
}

function validateOptOut(surface, value, projectRoot, readinessPath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      status: "FAIL",
      declaration: "opt_out",
      path: toRelative(projectRoot, readinessPath),
      issues: [
        buildSurfaceIssue(surface, "invalid_opt_out", `readiness.yaml opt_outs.${surface} must be an object`, toRelative(projectRoot, readinessPath)),
      ],
    };
  }

  if (value.not_applicable !== true) {
    return {
      ok: false,
      status: "FAIL",
      declaration: "opt_out",
      path: toRelative(projectRoot, readinessPath),
      issues: [
        buildSurfaceIssue(surface, "opt_out_missing_not_applicable", `opt_outs.${surface}.not_applicable must be true`, toRelative(projectRoot, readinessPath)),
      ],
    };
  }

  if (typeof value.reason !== "string" || !value.reason.trim()) {
    return {
      ok: false,
      status: "FAIL",
      declaration: "opt_out",
      path: toRelative(projectRoot, readinessPath),
      issues: [
        buildSurfaceIssue(surface, "opt_out_missing_reason", `opt_outs.${surface}.reason must be a non-empty string`, toRelative(projectRoot, readinessPath)),
      ],
    };
  }

  return {
    ok: true,
    status: "PASS",
    declaration: "opt_out",
    path: toRelative(projectRoot, readinessPath),
    reason: value.reason.trim(),
    issues: [],
  };
}

function validateArraySurface({ projectRoot, surface, filePath, topLevelKey }) {
  const read = readJsonCompatibleYaml(filePath);
  const relativePath = toRelative(projectRoot, filePath);

  if (!read.present) {
    return {
      ok: false,
      status: "FAIL",
      declaration: "configured",
      path: relativePath,
      issues: [
        buildSurfaceIssue(surface, "missing_surface_file", `${SURFACE_LABELS[surface]} file is missing`, relativePath),
      ],
    };
  }

  if (!read.usable || !read.parsed || typeof read.parsed !== "object" || Array.isArray(read.parsed)) {
    return {
      ok: false,
      status: "FAIL",
      declaration: "configured",
      path: relativePath,
      issues: [
        buildSurfaceIssue(surface, "invalid_surface_file", `${SURFACE_LABELS[surface]} must be valid JSON-compatible YAML`, relativePath),
      ],
    };
  }

  const entries = read.parsed[topLevelKey];
  if (!Array.isArray(entries)) {
    return {
      ok: false,
      status: "FAIL",
      declaration: "configured",
      path: relativePath,
      issues: [
        buildSurfaceIssue(surface, "invalid_surface_shape", `${SURFACE_LABELS[surface]} must expose a top-level ${topLevelKey} array`, relativePath),
      ],
    };
  }

  return {
    ok: true,
    status: "PASS",
    declaration: "configured",
    path: relativePath,
    entry_count: entries.length,
    issues: [],
  };
}

function validateDomainChecklists(projectRoot, directoryPath) {
  const relativePath = toRelative(projectRoot, directoryPath);
  if (!existsSync(directoryPath)) {
    return {
      ok: false,
      status: "FAIL",
      declaration: "configured",
      path: relativePath,
      checklist_count: 0,
      issues: [
        buildSurfaceIssue("domain_checklists", "missing_surface_directory", "domain_checklists directory is missing", relativePath),
      ],
    };
  }

  let names = [];
  try {
    names = readdirSync(directoryPath).filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"));
  } catch (error) {
    return {
      ok: false,
      status: "FAIL",
      declaration: "configured",
      path: relativePath,
      checklist_count: 0,
      issues: [
        buildSurfaceIssue("domain_checklists", "unreadable_surface_directory", error.message, relativePath),
      ],
    };
  }

  if (names.length === 0) {
    return {
      ok: false,
      status: "FAIL",
      declaration: "configured",
      path: relativePath,
      checklist_count: 0,
      issues: [
        buildSurfaceIssue("domain_checklists", "missing_checklist_files", "domain_checklists must contain at least one .yaml file", relativePath),
      ],
    };
  }

  const invalid = [];
  for (const name of names) {
    const filePath = join(directoryPath, name);
    const read = readJsonCompatibleYaml(filePath);
    if (!read.present || !read.usable || !read.parsed || typeof read.parsed !== "object" || Array.isArray(read.parsed)) {
      invalid.push(`${name}: invalid JSON-compatible YAML`);
      continue;
    }
    if (typeof read.parsed.domain !== "string" || !read.parsed.domain.trim()) {
      invalid.push(`${name}: missing domain`);
      continue;
    }
    if (!Array.isArray(read.parsed.triggers)) {
      invalid.push(`${name}: missing triggers array`);
      continue;
    }
    if (!Array.isArray(read.parsed.execute_checklist)) {
      invalid.push(`${name}: missing execute_checklist array`);
      continue;
    }
  }

  if (invalid.length > 0) {
    return {
      ok: false,
      status: "FAIL",
      declaration: "configured",
      path: relativePath,
      checklist_count: names.length,
      issues: invalid.map((message) =>
        buildSurfaceIssue("domain_checklists", "invalid_domain_checklist", message, relativePath)
      ),
    };
  }

  return {
    ok: true,
    status: "PASS",
    declaration: "configured",
    path: relativePath,
    checklist_count: names.length,
    files: names.sort(),
    issues: [],
  };
}

function validateTelemetryDeclaration(projectRoot, readinessPath) {
  return {
    ok: true,
    status: "PASS",
    declaration: "configured",
    path: toRelative(projectRoot, readinessPath),
    issues: [],
    note: "Telemetry capture is declared in readiness.yaml. Full hook/history enforcement stays with the existing telemetry-readiness surfaces and later rollout-gate work.",
  };
}

function validateStoryRegistrySurface(projectRoot) {
  const registryPath = join(projectRoot, "reports", "user_story_audit", "story_registry.json");
  const storyRegistryScript = join(__dirname, "story_registry.mjs");

  if (!existsSync(registryPath)) {
    return {
      ok: false,
      status: "FAIL",
      declaration: "configured",
      path: toRelative(projectRoot, registryPath),
      issues: [
        buildSurfaceIssue("story_registry", "missing_surface_file", "story_registry.json is missing", toRelative(projectRoot, registryPath)),
      ],
      warnings: [],
    };
  }

  const proc = spawnSync(process.execPath, [storyRegistryScript, "check", "--json"], {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_THREAD_ID: "",
      _PLANNER_PLAN_TARGET: "",
    },
    timeout: 10_000,
  });

  let parsed = null;
  try {
    parsed = JSON.parse(proc.stdout || "{}");
  } catch {
    parsed = null;
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      ok: false,
      status: "FAIL",
      declaration: "configured",
      path: toRelative(projectRoot, registryPath),
      issues: [
        buildSurfaceIssue("story_registry", "reader_check_failed", "story_registry.mjs check did not return valid JSON", toRelative(projectRoot, registryPath)),
      ],
      warnings: [],
    };
  }

  const childPassed = proc.status === 0 && verificationStatusIsPass(parsed.status, "execution");
  return {
    ok: childPassed,
    status: childPassed ? "PASS" : "FAIL",
    declaration: "configured",
    path: toRelative(projectRoot, registryPath),
    story_count: Number(parsed.storyCount) || 0,
    issues: (parsed.errors || []).map((message) =>
      buildSurfaceIssue("story_registry", "story_registry_invalid", message, toRelative(projectRoot, registryPath))
    ),
    warnings: (parsed.warnings || []).map((message) =>
      buildSurfaceIssue("story_registry", "story_registry_warning", message, toRelative(projectRoot, registryPath))
    ),
  };
}

function resolveSurfaceDeclaration(readiness, surface) {
  const declared = readiness?.[surface];
  const optOut = readiness?.opt_outs?.[surface];
  return { declared, optOut };
}

export function validateSubstrateReadiness(projectRoot = process.cwd()) {
  const readinessPath = join(projectRoot, READINESS_RELATIVE_PATH);
  const readinessRead = readJsonCompatibleYaml(readinessPath);

  const result = {
    ok: false,
    status: "FAIL",
    readiness_path: toRelative(projectRoot, readinessPath),
    surfaces: {},
    errors: [],
    warnings: [],
  };

  if (!readinessRead.present) {
    result.errors.push(buildSurfaceIssue("readiness", "missing_readiness", "readiness.yaml is missing", result.readiness_path));
    return result;
  }

  if (!readinessRead.usable || !readinessRead.parsed || typeof readinessRead.parsed !== "object" || Array.isArray(readinessRead.parsed)) {
    result.errors.push(buildSurfaceIssue("readiness", "invalid_readiness", "readiness.yaml must be valid JSON-compatible YAML", result.readiness_path));
    return result;
  }

  const readiness = readinessRead.parsed.readiness;
  if (!readiness || typeof readiness !== "object" || Array.isArray(readiness)) {
    result.errors.push(buildSurfaceIssue("readiness", "invalid_readiness_shape", "readiness.yaml must expose a top-level readiness object", result.readiness_path));
    return result;
  }

  for (const surface of SURFACE_ORDER) {
    const { declared, optOut } = resolveSurfaceDeclaration(readiness, surface);
    let surfaceResult;

    if (declared === "configured") {
      if (surface === "story_registry") {
        surfaceResult = validateStoryRegistrySurface(projectRoot);
      } else if (surface === "mutex_facts") {
        surfaceResult = validateArraySurface({
          projectRoot,
          surface,
          filePath: join(projectRoot, MUTEX_FACTS_RELATIVE_PATH),
          topLevelKey: "mutex_facts",
        });
      } else if (surface === "postconditions") {
        surfaceResult = validateArraySurface({
          projectRoot,
          surface,
          filePath: join(projectRoot, POSTCONDITIONS_RELATIVE_PATH),
          topLevelKey: "postconditions",
        });
      } else if (surface === "domain_checklists") {
        surfaceResult = validateDomainChecklists(projectRoot, join(projectRoot, DOMAIN_CHECKLISTS_RELATIVE_PATH));
      } else {
        surfaceResult = validateTelemetryDeclaration(projectRoot, readinessPath);
      }
    } else if (optOut) {
      surfaceResult = validateOptOut(surface, optOut, projectRoot, readinessPath);
    } else {
      surfaceResult = {
        ok: false,
        status: "FAIL",
        declaration: "missing",
        path: result.readiness_path,
        issues: [
          buildSurfaceIssue(surface, "missing_declaration", `${SURFACE_LABELS[surface]} must be declared as configured or explicitly opted out in readiness.yaml`, result.readiness_path),
        ],
      };
    }

    result.surfaces[surface] = surfaceResult;
    for (const issue of surfaceResult.issues || []) result.errors.push(issue);
    for (const warning of surfaceResult.warnings || []) result.warnings.push(warning);
  }

  result.ok = result.errors.length === 0;
  result.status = result.errors.length > 0 ? "FAIL" : (result.warnings.length > 0 ? "WARN" : "PASS");
  return result;
}

function formatSurfaceLine(surface, surfaceResult) {
  const label = SURFACE_LABELS[surface] || surface;
  const status = surfaceResult?.status || "FAIL";
  const path = surfaceResult?.path ? ` (${surfaceResult.path})` : "";
  const suffix = surfaceResult?.declaration === "opt_out"
    ? ` — opt-out: ${surfaceResult.reason}`
    : "";
  return `  ${label}: ${status}${path}${suffix}`;
}

function formatHumanOutput(result) {
  const lines = [];
  lines.push("substrate check");
  lines.push(`  Readiness: ${result.readiness_path}`);
  for (const surface of SURFACE_ORDER) {
    lines.push(formatSurfaceLine(surface, result.surfaces[surface]));
  }
  if (result.errors.length > 0) {
    for (const issue of result.errors) {
      lines.push(`  ERROR: ${issue.surface} — ${issue.message}`);
    }
  }
  if (result.warnings.length > 0) {
    for (const issue of result.warnings) {
      lines.push(`  WARN: ${issue.surface} — ${issue.message}`);
    }
  }
  if (result.errors.length === 0 && result.warnings.length === 0) {
    lines.push("  All declared substrate surfaces are configured or explicitly opted out.");
  }
  return lines.join("\n");
}

export async function runSubstrateCommand({ projectRoot = process.cwd(), args = [] } = {}) {
  const json = args.includes("--json");
  const command = args.find((arg) => !arg.startsWith("--")) || null;

  if (command !== "check") {
    const error = {
      ok: false,
      status: "FAIL",
      message: "Usage: bootstrap.mjs substrate check [--json]",
    };
    if (json) console.log(JSON.stringify(error, null, 2));
    else console.error(error.message);
    return 1;
  }

  const result = validateSubstrateReadiness(projectRoot);
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatHumanOutput(result));
  return result.ok ? 0 : 1;
}

const isMain = process.argv[1] && process.argv[1].includes("substrate_check");
if (isMain) {
  const exitCode = await runSubstrateCommand({
    projectRoot: process.cwd(),
    args: process.argv.slice(2),
  });
  process.exit(exitCode);
}
