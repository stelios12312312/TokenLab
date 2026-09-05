import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL("../../config/model_assurance.json", import.meta.url));
const PROFILE_ORDER = Object.freeze(["standard", "enhanced", "critical"]);
const TRUSTED_PROVENANCE = new Set(["observed", "user_declared"]);

export function loadModelAssuranceConfig(path = DEFAULT_CONFIG_PATH) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  const issues = [];
  if (config.schema_version !== 1) issues.push("schema_version must equal 1");
  if (config.selection_mode !== "adaptive") issues.push("selection_mode must be adaptive");
  if (!PROFILE_ORDER.includes(config.configured_floor)) issues.push("configured_floor must be a governed profile");
  if (config.profile_override_policy?.model_output_can_lower !== false) issues.push("profile_override_policy.model_output_can_lower must be false");
  if (config.profile_override_policy?.operator_floor_can_raise !== true) issues.push("profile_override_policy.operator_floor_can_raise must be true");
  if (config.profile_override_policy?.unknown_identity_can_infer !== false) issues.push("profile_override_policy.unknown_identity_can_infer must be false");
  for (const [index, name] of PROFILE_ORDER.entries()) {
    const profile = config.profiles?.[name];
    if (!profile || profile.rank !== index + 1) issues.push(`${name}.rank must equal ${index + 1}`);
    if (!Number.isInteger(profile?.retry_budget) || profile.retry_budget < 0 || profile.retry_budget > 2) issues.push(`${name}.retry_budget must be between 0 and 2`);
    if (!Array.isArray(profile?.required_checks) || profile.required_checks.length === 0) issues.push(`${name}.required_checks must be non-empty`);
  }
  if (issues.length) throw new Error(`Invalid model assurance config: ${issues.join("; ")}`);
  return config;
}

function governedProfile(value, fallback = "standard") {
  return PROFILE_ORDER.includes(value) ? value : fallback;
}

function maxProfile(config, candidates) {
  return candidates
    .map((value) => governedProfile(value))
    .sort((left, right) => config.profiles[right].rank - config.profiles[left].rank)[0];
}

export function resolveModelAssurance({
  configuredFloor,
  taskRisk = "standard",
  capability = null,
  observedFailures = 0,
  requestedProfile = null,
  config = loadModelAssuranceConfig(),
} = {}) {
  const warnings = [];
  const floor = governedProfile(configuredFloor, config.configured_floor);
  const risk = governedProfile(taskRisk);
  const provenance = TRUSTED_PROVENANCE.has(capability?.provenance) ? capability.provenance : "unknown";
  const capabilityProfile = provenance === "unknown" ? "standard" : governedProfile(capability?.profile);
  if (capability && provenance === "unknown") warnings.push("untrusted model capability metadata ignored; identity remains unknown");
  const failureCount = Math.max(0, Number.isFinite(Number(observedFailures)) ? Number(observedFailures) : 0);
  const failureProfile = failureCount >= config.failure_escalation.critical_at
    ? "critical"
    : failureCount >= config.failure_escalation.enhanced_at ? "enhanced" : "standard";
  const effective = maxProfile(config, [floor, risk, capabilityProfile, failureProfile]);
  const requested = requestedProfile ? governedProfile(requestedProfile) : null;
  const downgradeRejected = Boolean(requested && config.profiles[requested].rank < config.profiles[effective].rank);
  if (downgradeRejected) warnings.push(`requested assurance downgrade ${requested} rejected below governed ${effective} profile`);

  return {
    ok: true,
    schema_version: config.schema_version,
    selection_mode: config.selection_mode,
    effective_profile: effective,
    configured_floor: floor,
    task_risk: risk,
    capability_profile: capabilityProfile,
    identity_provenance: provenance,
    observed_failures: failureCount,
    downgrade_rejected: downgradeRejected,
    retry_budget: config.profiles[effective].retry_budget,
    required_checks: [...config.profiles[effective].required_checks],
    normal_surface: { ...config.normal_surface },
    warnings,
  };
}
