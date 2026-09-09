// github_mirror.mjs — Default push-only GitHub Issues mirror for Program Packets.
// @planner:module = github_mirror
// @planner:capability = program_packet_github_mirror

import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { redactSecrets } from "./provider_client.mjs";
import { normalizeRemoteMode, REMOTE_MODES } from "./remote_mode.mjs";

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function detectGitRemoteSlug(projectRoot = process.cwd()) {
  try {
    const res = spawnSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: projectRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL || "/dev/null",
        GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM || "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    if (res.status !== 0 || !res.stdout) return null;
    const url = res.stdout.trim();
    const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function normalizeModeString(val) {
  if (!val || typeof val !== "string") return null;
  try {
    return normalizeRemoteMode(val);
  } catch {
    return "invalid";
  }
}

export function resolveGithubMirrorConfig({
  projectRoot = process.cwd(),
  explicitRepo = null,
  explicitMirror = null,
  policy = null,
  packet = null,
  env = process.env,
  remoteMode = null,
} = {}) {
  let explicit = null;
  if (explicitMirror !== null && explicitMirror !== undefined) {
    explicit = Boolean(explicitMirror);
  } else if (env?.PLANNER_GITHUB_MIRROR !== undefined) {
    const val = env.PLANNER_GITHUB_MIRROR.trim().toLowerCase();
    explicit = val !== "0" && val !== "false" && val !== "off" && val !== "no";
  } else if (policy?.github_mirror !== undefined) {
    explicit = Boolean(policy.github_mirror);
  } else if (packet?.remote_policy?.github_mirror !== undefined) {
    explicit = Boolean(packet.remote_policy.github_mirror);
  }

  const packetRepo = packet?.remote_policy?.repository_slug || packet?.remote_policy?.repo || packet?.repo;
  const configuredRepo = asString(explicitRepo) || asString(packetRepo);
  const repo = configuredRepo || detectGitRemoteSlug(projectRoot);

  const rawPMode = packet?.remote_mode;
  const rawPolicyMode = packet?.remote_policy?.mode;
  const rawCliMode = remoteMode;
  const rawEnvMode = env?.PLANNER_REMOTE_MODE;

  const pMode = normalizeModeString(rawPMode);
  const policyMode = normalizeModeString(rawPolicyMode);
  const cliMode = normalizeModeString(rawCliMode);
  const envMode = normalizeModeString(rawEnvMode);

  // Check for any malformed/invalid mode strings
  if (
    (rawPMode && pMode === "invalid") ||
    (rawPolicyMode && policyMode === "invalid") ||
    (rawCliMode && cliMode === "invalid") ||
    (rawEnvMode && envMode === "invalid")
  ) {
    const invalidVal = (rawPMode && pMode === "invalid") ? rawPMode :
      (rawPolicyMode && policyMode === "invalid") ? rawPolicyMode :
      (rawCliMode && cliMode === "invalid") ? rawCliMode : rawEnvMode;
    return {
      enabled: false,
      repo: null,
      remoteMode: "invalid",
      conflict: true,
      error: `Invalid or unsupported remote mode: '${invalidVal}'. Expected one of: ${REMOTE_MODES.join(", ")}`,
      reason: "invalid_remote_mode",
      source: "conflict",
    };
  }

  // Check for internal conflict in packet policy vs top-level remote mode
  if (pMode && policyMode && pMode !== policyMode) {
    return {
      enabled: false,
      repo: null,
      remoteMode: "local-only",
      conflict: true,
      error: `Conflicting remote modes in packet: remote_mode='${pMode}' vs remote_policy.mode='${policyMode}'`,
      reason: "conflicting_remote_policy",
      source: "conflict",
    };
  }

  const effectiveMode = cliMode ||
    policyMode ||
    pMode ||
    envMode ||
    null;

  const normalizedMode = effectiveMode || "local-only";
  const isRemoteSync = normalizedMode === "remote-sync";

  // Check for conflict between mirror enablement and non-remote-sync mode
  if (!isRemoteSync && explicit === true) {
    return {
      enabled: false,
      repo: null,
      remoteMode: normalizedMode,
      conflict: true,
      error: `Explicit mirror enabled is invalid in ${normalizedMode} mode`,
      reason: `remote_mode_${normalizedMode}`,
      source: "conflict",
    };
  }

  // Authority boundary: every remote write strictly requires validated remote-sync mode
  let enabled = false;
  if (isRemoteSync && repo) {
    if (explicit !== null) {
      enabled = explicit;
    } else {
      enabled = true;
    }
  }

  return {
    enabled,
    repo: enabled ? repo : (!isRemoteSync ? null : repo),
    remoteMode: normalizedMode,
    source: explicit !== null ? (explicitMirror !== null ? "cli" : policy?.github_mirror !== undefined ? "policy" : "env") : (enabled ? "auto" : "none"),
  };
}

export function defaultGhRunner(args, cwd = process.cwd()) {
  try {
    const res = spawnSync("gh", args, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      status: res.status ?? 1,
      ok: res.status === 0,
      stdout: res.stdout || "",
      stderr: res.stderr || "",
    };
  } catch (error) {
    return {
      status: 1,
      ok: false,
      stdout: "",
      stderr: error.message,
    };
  }
}

function renderIssueBody({ packet, ticket, env }) {
  const lines = [
    `<!-- planner-ticket-publish:${ticket.id || "unknown"} -->`,
    `# [${packet.id}] ${ticket.title}`,
    "",
    "## Description",
    asString(ticket.description) || asString(ticket.text) || "No description provided.",
    "",
  ];

  if (asArray(ticket.acceptance_criteria).length > 0) {
    lines.push("## Acceptance Criteria");
    for (const c of ticket.acceptance_criteria) {
      lines.push(`- \`${c.id || "AC"}\`: ${asString(c.text || c.summary)}`);
    }
    lines.push("");
  }

  if (asArray(ticket.verification_rows).length > 0) {
    lines.push("## Verification");
    for (const v of ticket.verification_rows) {
      lines.push(`- \`${v.id || "VR"}\`: ${asString(v.command_or_action)}`);
    }
    lines.push("");
  }

  lines.push(
    "---",
    `*Program:* \`${packet.id}\` | *Ticket:* \`${ticket.id}\` | *Lifecycle:* \`${ticket.lifecycle || "proposed"}\``
  );

  return redactSecrets(lines.join("\n"), env);
}

export function ensureRepoLabels({
  cwd = process.cwd(),
  repo,
  labels = [],
  ghRunner = defaultGhRunner,
  remoteMode = null,
  packet = null,
  policy = null,
  explicitMirror = null,
  env = process.env,
} = {}) {
  const config = resolveGithubMirrorConfig({
    projectRoot: cwd,
    explicitRepo: repo,
    explicitMirror,
    policy,
    packet,
    env,
    remoteMode,
  });
  if (!config.enabled || !config.repo) {
    return;
  }
  for (const label of labels) {
    if (!label) continue;
    try {
      ghRunner(["label", "create", label, "--repo", config.repo, "--description", "Planner Program Packet mirror label", "--color", "0075ca"], cwd);
    } catch {
      // Best-effort
    }
  }
}

export function mirrorTicketPublish({
  projectRoot = process.cwd(),
  packet,
  ticket,
  repo,
  ghRunner = defaultGhRunner,
  env = process.env,
  remoteMode = null,
  policy = null,
  explicitMirror = null,
}) {
  const config = resolveGithubMirrorConfig({
    projectRoot,
    explicitRepo: repo,
    explicitMirror,
    policy: policy || packet?.policy || null,
    packet,
    env,
    remoteMode,
  });

  if (!config.enabled) {
    return {
      status: "skipped",
      reason: config.reason || `remote_mode_${config.remoteMode}`,
      conflict: config.conflict || false,
      error: config.error || null,
    };
  }

  const resolvedRepo = config.repo;
  if (!resolvedRepo) {
    return { status: "skipped", reason: "no_repo_configured" };
  }

  if (ticket.github_sync?.published_issue_number) {
    return {
      status: "existing",
      issue_number: ticket.github_sync.published_issue_number,
      url: ticket.github_sync.url,
    };
  }

  const title = redactSecrets(`[${packet.id}] ${ticket.title}`, env);
  const body = renderIssueBody({ packet, ticket, env });
  const labels = [
    `program:${packet.id.toLowerCase()}`,
    `lifecycle:${ticket.lifecycle || "proposed"}`,
  ];

  ensureRepoLabels({ cwd: projectRoot, repo: resolvedRepo, labels, ghRunner, remoteMode: config.remoteMode, explicitMirror: true });

  const args = [
    "issue",
    "create",
    "--repo", resolvedRepo,
    "--title", title,
    "--body", body,
  ];
  for (const label of labels) {
    args.push("--label", label);
  }

  let res = ghRunner(args, projectRoot);
  if (!res.ok && res.stderr?.includes("not found")) {
    // Retry without labels if label creation was rejected
    res = ghRunner(["issue", "create", "--repo", resolvedRepo, "--title", title, "--body", body], projectRoot);
  }

  if (res.ok) {
    const output = res.stdout.trim();
    const match = output.match(/(\d+)$/);
    const issueNumber = match ? parseInt(match[1], 10) : null;
    ticket.github_sync = {
      status: "synced",
      published_issue_number: issueNumber,
      url: output,
      published_at: new Date().toISOString(),
      pending_action: null,
    };
    if (!asArray(ticket.external_refs).some((r) => r.kind === "github_issue")) {
      ticket.external_refs = [
        ...asArray(ticket.external_refs),
        { kind: "github_issue", repo: resolvedRepo, issue_number: issueNumber, url: output },
      ];
    }
    return { status: "published", issue_number: issueNumber, url: output };
  } else {
    ticket.github_sync = {
      status: "queued",
      pending_action: "publish",
      last_attempt_at: new Date().toISOString(),
      error: res.stderr || "Failed to execute gh issue create",
    };
    return { status: "queued", error: res.stderr };
  }
}

export function mirrorTicketClose({
  projectRoot = process.cwd(),
  packet,
  ticket,
  repo,
  comment = null,
  ghRunner = defaultGhRunner,
  env = process.env,
  remoteMode = null,
  policy = null,
  explicitMirror = null,
}) {
  const config = resolveGithubMirrorConfig({
    projectRoot,
    explicitRepo: repo,
    explicitMirror,
    policy: policy || packet?.policy || null,
    packet,
    env,
    remoteMode,
  });

  if (!config.enabled) {
    return {
      status: "skipped",
      reason: config.reason || `remote_mode_${config.remoteMode}`,
      conflict: config.conflict || false,
      error: config.error || null,
    };
  }

  const resolvedRepo = config.repo;
  const issueNumber = ticket.github_sync?.published_issue_number ||
    asArray(ticket.external_refs).find((r) => r.kind === "github_issue")?.issue_number;
  if (!issueNumber || !resolvedRepo) {
    return { status: "skipped", reason: "no_issue_or_repo" };
  }

  const closeComment = comment || `Closed by Program ${packet.id} ticket ${ticket.id}.`;
  const res = ghRunner(["issue", "close", String(issueNumber), "--repo", resolvedRepo, "--comment", closeComment], projectRoot);
  if (res.ok) {
    ticket.github_sync = {
      ...(ticket.github_sync || {}),
      status: "synced",
      closed_at: new Date().toISOString(),
      pending_action: null,
    };
    return { status: "closed", issue_number: issueNumber };
  } else {
    ticket.github_sync = {
      ...(ticket.github_sync || {}),
      status: "queued",
      pending_action: "close",
      last_attempt_at: new Date().toISOString(),
      error: res.stderr || "Failed to execute gh issue close",
    };
    return { status: "queued", error: res.stderr };
  }
}

export function mirrorTicketDefer({
  projectRoot = process.cwd(),
  packet,
  ticket,
  repo,
  ghRunner = defaultGhRunner,
  env = process.env,
  remoteMode = null,
  policy = null,
  explicitMirror = null,
}) {
  const config = resolveGithubMirrorConfig({
    projectRoot,
    explicitRepo: repo,
    explicitMirror,
    policy: policy || packet?.policy || null,
    packet,
    env,
    remoteMode,
  });

  if (!config.enabled) {
    return {
      status: "skipped",
      reason: config.reason || `remote_mode_${config.remoteMode}`,
      conflict: config.conflict || false,
      error: config.error || null,
    };
  }

  const resolvedRepo = config.repo;
  const issueNumber = ticket.github_sync?.published_issue_number ||
    asArray(ticket.external_refs).find((r) => r.kind === "github_issue")?.issue_number;
  if (!issueNumber || !resolvedRepo) {
    return { status: "skipped", reason: "no_issue_or_repo" };
  }

  const res = ghRunner(["issue", "edit", String(issueNumber), "--repo", resolvedRepo, "--add-label", "lifecycle:deferred"], projectRoot);
  if (res.ok) {
    ticket.github_sync = {
      ...(ticket.github_sync || {}),
      status: "synced",
      deferred_at: new Date().toISOString(),
      pending_action: null,
    };
    return { status: "deferred", issue_number: issueNumber };
  } else {
    ticket.github_sync = {
      ...(ticket.github_sync || {}),
      status: "queued",
      pending_action: "defer",
      last_attempt_at: new Date().toISOString(),
      error: res.stderr || "Failed to execute gh issue edit",
    };
    return { status: "queued", error: res.stderr };
  }
}
