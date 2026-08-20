#!/usr/bin/env node
// snapshot_branch_protection.mjs
// Capture optional GitHub branch-protection diagnostics without treating remote state as local release authority.

import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { emitJson } from "./lib/emit_json.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const repoRoot = resolve(scriptDir, "..", "..", "..", "..");

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function ghJson(args) {
  try {
    const stdout = execFileSync("gh", args, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, json: JSON.parse(stdout) };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      status: error.status || 1,
    };
  }
}

function classifyProtectionError(result) {
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  // Match GitHub's private-repo upsell text while keeping this program's policy private-only.
  if (/Upgrade to GitHub Pro|make this repository public|HTTP 403|status.*403|Resource not accessible/i.test(text)) {
    return {
      status: "unavailable",
      reason: "Optional GitHub branch-protection observation is unavailable for this private repo/account. This does not block or satisfy the repository's local governed replay and exact-commit release contract.",
      http_status: 403,
    };
  }
  if (/HTTP 404|status.*404|Branch not protected|not found/i.test(text)) {
    return {
      status: "not_protected",
      reason: "GitHub reports no branch protection for this branch.",
      http_status: 404,
    };
  }
  return {
    status: "error",
    reason: text.trim() || "gh branch-protection query failed",
    http_status: null,
  };
}

function contextsFromProtection(protection) {
  const contexts = protection?.required_status_checks?.contexts;
  if (Array.isArray(contexts)) return contexts;
  const checks = protection?.required_status_checks?.checks;
  if (Array.isArray(checks)) return checks.map((entry) => entry.context || entry.name).filter(Boolean);
  return [];
}

function summarizeProtection(protection) {
  const contexts = contextsFromProtection(protection);
  const iveRequired = contexts.some((entry) => entry === "ive-conformance" || entry === "ive-conformance / conformance");
  const pullRequestRequired = !!protection?.required_pull_request_reviews;
  const adminsEnforced = !!protection?.enforce_admins?.enabled;
  const enforced = iveRequired && pullRequestRequired && adminsEnforced;

  return {
    status: enforced ? "enforced" : "not_protected",
    reason: enforced
      ? "Optional branch-protection observation includes the legacy IVE context, pull-request review, and admin enforcement; it is diagnostic only."
      : "Optional branch-protection configuration was observed but is not this repository's enforcement authority.",
    required_status_checks: protection?.required_status_checks || null,
    required_pull_request_reviews: protection?.required_pull_request_reviews || null,
    enforce_admins: protection?.enforce_admins || null,
    restrictions: protection?.restrictions || null,
    enforcement: {
      ive_conformance_required: iveRequired,
      pull_request_reviews_required: pullRequestRequired,
      admins_enforced: adminsEnforced,
      contexts,
    },
  };
}

const repo = argValue("--repo", "stelios12312312/portable-agent-kit");
const branch = argValue("--branch", "main");
const write = hasFlag("--write");
const requireEnforced = hasFlag("--require-enforced");
const outputPath = argValue("--output", join(repoRoot, ".github", "branch-protection.snapshot.json"));

const repoResult = ghJson(["repo", "view", repo, "--json", "isPrivate,viewerPermission,nameWithOwner"]);
const protectionResult = ghJson(["api", `repos/${repo}/branches/${branch}/protection`]);

const base = {
  schema_version: 1,
  repo,
  branch,
  captured_at: new Date().toISOString(),
  source: "gh",
  repo_visibility: repoResult.ok ? {
    is_private: repoResult.json.isPrivate,
    viewer_permission: repoResult.json.viewerPermission,
  } : null,
};

const snapshot = protectionResult.ok
  ? { ...base, ...summarizeProtection(protectionResult.json) }
  : { ...base, ...classifyProtectionError(protectionResult) };

if (write) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

// proof-status-lint: exempt T-INTAKE-B07B8898 -- GitHub snapshot transport and domain error lifecycle controls whether a snapshot was obtained.
const snapshotErrored = snapshot.status === "error";
const exitCode = requireEnforced && snapshot.status !== "enforced"
  ? 2
  : snapshotErrored ? 1 : 0;
emitJson(snapshot, { exitCode });
