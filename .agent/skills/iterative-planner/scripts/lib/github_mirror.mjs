// github_mirror.mjs — Default push-only GitHub Issues mirror for Program Packets.
// @planner:module = github_mirror
// @planner:capability = program_packet_github_mirror

import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { redactSecrets } from "./provider_client.mjs";

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
    });
    if (res.status !== 0 || !res.stdout) return null;
    const url = res.stdout.trim();
    const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function resolveGithubMirrorConfig({
  projectRoot = process.cwd(),
  explicitRepo = null,
  explicitMirror = null,
  policy = null,
  packet = null,
  env = process.env,
} = {}) {
  let explicit = null;
  if (explicitMirror !== null && explicitMirror !== undefined) {
    explicit = Boolean(explicitMirror);
  } else if (env?.PLANNER_GITHUB_MIRROR !== undefined) {
    const val = env.PLANNER_GITHUB_MIRROR.trim().toLowerCase();
    explicit = val !== "0" && val !== "false" && val !== "off" && val !== "no";
  } else if (policy?.github_mirror !== undefined) {
    explicit = Boolean(policy.github_mirror);
  }

  const packetRepo = packet?.remote_policy?.repository_slug || packet?.remote_policy?.repo || packet?.repo;
  const repo = asString(explicitRepo) || asString(packetRepo) || detectGitRemoteSlug(projectRoot);
  const enabled = explicit !== null ? (explicit && Boolean(repo)) : Boolean(repo);

  return {
    enabled,
    repo,
    source: explicit !== null ? (explicitMirror !== null ? "cli" : policy?.github_mirror !== undefined ? "policy" : "env") : (repo ? "auto" : "none"),
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

export function ensureRepoLabels({ cwd = process.cwd(), repo, labels = [], ghRunner = defaultGhRunner }) {
  for (const label of labels) {
    if (!label) continue;
    try {
      ghRunner(["label", "create", label, "--repo", repo, "--description", "Planner Program Packet mirror label", "--color", "0075ca"], cwd);
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
}) {
  if (!repo) {
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

  ensureRepoLabels({ cwd: projectRoot, repo, labels, ghRunner });

  const args = [
    "issue",
    "create",
    "--repo", repo,
    "--title", title,
    "--body", body,
  ];
  for (const label of labels) {
    args.push("--label", label);
  }

  let res = ghRunner(args, projectRoot);
  if (!res.ok && res.stderr?.includes("not found")) {
    // Retry without labels if label creation was rejected
    res = ghRunner(["issue", "create", "--repo", repo, "--title", title, "--body", body], projectRoot);
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
        { kind: "github_issue", repo, issue_number: issueNumber, url: output },
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
}) {
  const issueNumber = ticket.github_sync?.published_issue_number ||
    asArray(ticket.external_refs).find((r) => r.kind === "github_issue")?.issue_number;
  if (!issueNumber || !repo) {
    return { status: "skipped", reason: "no_issue_or_repo" };
  }

  const closeComment = comment || `Closed by Program ${packet.id} ticket ${ticket.id}.`;
  const res = ghRunner(["issue", "close", String(issueNumber), "--repo", repo, "--comment", closeComment], projectRoot);
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
}) {
  const issueNumber = ticket.github_sync?.published_issue_number ||
    asArray(ticket.external_refs).find((r) => r.kind === "github_issue")?.issue_number;
  if (!issueNumber || !repo) {
    return { status: "skipped", reason: "no_issue_or_repo" };
  }

  const res = ghRunner(["issue", "edit", String(issueNumber), "--repo", repo, "--add-label", "lifecycle:deferred"], projectRoot);
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
