#!/usr/bin/env node
// @planner:story_id US-087
// @planner:proves = crit:CRIT-001, crit:CRIT-004

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { spawnSync } from "child_process";
import { canonicalizeStoryLinkToken } from "./lib/planner_canonicalizer.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { evaluateExecutedProofRef } from "./story_registry.mjs";

const REGISTRY_RELATIVE_PATH = join("reports", "user_story_audit", "story_registry.json");
const VALID_STATUSES = new Set(["FULLY_COVERED", "PARTIALLY_COVERED", "NOT_IMPLEMENTED", "RETIRED"]);
const LEGACY_STORY_ID_PATTERN = /^(US|D|FEAT)-[0-9]{3,}$/;
const REPEATABLE_OPTIONS = new Set(["acceptance", "code-ref", "test-ref", "doc-ref", "validation-ref", "executed-proof-ref"]);
const EXECUTED_PROOF_KEYS = ["artifact", "kind", "selector"];

function usage() {
  return [
    "planner story — canonical story registry writer",
    "",
    "Usage:",
    "  planner story new [title] [--id US-042] [--title \"...\"] [--status NOT_IMPLEMENTED] [--acceptance \"...\"]... [--tags a,b] [--json]",
    "  planner story list [--status FULLY_COVERED] [--needs-review] [--json]",
    "  planner story show <story-id> [--json]",
    "  planner story update <story-id> [--title \"...\"] [--status PARTIALLY_COVERED] [--acceptance \"...\"]... [--tags a,b] [--code-ref <ref>]... [--test-ref <ref>]... [--doc-ref <ref>]... [--validation-ref <ref>]... [--executed-proof-ref '{\"kind\":\"ive_suite\",\"artifact\":\"...\",\"selector\":\"...\"}']... [--dry-run] [--json]",
    "  planner story retire <story-id> [--reason \"...\"] [--json]",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      options._.push(arg);
      continue;
    }
    const raw = arg.slice(2);
    const [key, inlineValue] = raw.split("=", 2);
    if (key === "json" || key === "needs-review" || key === "dry-run") {
      options[key] = true;
      continue;
    }
    const value = inlineValue !== undefined ? inlineValue : argv[++i];
    if (value === undefined) throw new Error(`Missing value for --${key}`);
    if (REPEATABLE_OPTIONS.has(key)) {
      options[key] = options[key] || [];
      options[key].push(value);
    } else {
      options[key] = value;
    }
  }
  return options;
}

function normalizeId(value) {
  return String(value || "").trim().toUpperCase();
}

function assertStoryId(id) {
  if (!LEGACY_STORY_ID_PATTERN.test(id) && canonicalizeStoryLinkToken(id) !== id) {
    throw new Error(`Invalid story id ${JSON.stringify(id)}; expected legacy US-NNN, D-NNN, FEAT-NNN, or a canonical US domain id such as US-PM-AUTO-181.`);
  }
}

function registryPath(cwd = process.cwd()) {
  return join(cwd, REGISTRY_RELATIVE_PATH);
}

function currentCommit(cwd = process.cwd()) {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf-8", timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

function loadRegistry(cwd = process.cwd()) {
  const path = registryPath(cwd);
  if (!existsSync(path)) {
    return {
      version: 1,
      updated: new Date().toISOString(),
      commit: currentCommit(cwd),
      stories: [],
      consolidations: [],
      updated_at: new Date().toISOString(),
    };
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeRegistry(registry, cwd = process.cwd()) {
  const now = new Date().toISOString();
  registry.updated = now;
  registry.updated_at = now;
  if (!registry.commit) {
    const commit = currentCommit(cwd);
    if (commit) registry.commit = commit;
  }
  if (!Array.isArray(registry.stories)) registry.stories = [];
  if (!Array.isArray(registry.consolidations)) registry.consolidations = [];

  const path = registryPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(registry, null, 2)}\n`);
  renameSync(tmpPath, path);
}

function nextStoryId(stories) {
  const max = stories.reduce((highest, story) => {
    const match = String(story?.id || "").match(/^US-([0-9]+)$/);
    return match ? Math.max(highest, Number.parseInt(match[1], 10)) : highest;
  }, 0);
  return `US-${String(max + 1).padStart(3, "0")}`;
}

function parseTags(value) {
  if (!value) return [];
  return String(value).split(",").map((tag) => tag.trim()).filter(Boolean);
}

function normalizeEvidenceRef(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function mergeEvidenceRefs(existing, additions) {
  return [...new Set([
    ...(Array.isArray(existing) ? existing : []),
    ...(Array.isArray(additions) ? additions : []),
  ].map(normalizeEvidenceRef).filter(Boolean))];
}

function normalizeExecutedProofRef(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch (error) {
    throw new Error(`Invalid --executed-proof-ref JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--executed-proof-ref must be a JSON object");
  }
  const keys = Object.keys(parsed).sort();
  if (JSON.stringify(keys) !== JSON.stringify(EXECUTED_PROOF_KEYS)) {
    throw new Error(`--executed-proof-ref requires exactly these fields: ${EXECUTED_PROOF_KEYS.join(", ")}`);
  }
  for (const key of EXECUTED_PROOF_KEYS) {
    if (typeof parsed[key] !== "string" || parsed[key].trim() === "") {
      throw new Error(`--executed-proof-ref field '${key}' must be a non-blank string`);
    }
  }
  const proofRef = {
    kind: parsed.kind.trim(),
    artifact: normalizeEvidenceRef(parsed.artifact),
    selector: parsed.selector.trim(),
  };
  const evaluation = evaluateExecutedProofRef(proofRef, { cwd: process.cwd() });
  if (!evaluation.ok) {
    throw new Error(`Invalid --executed-proof-ref: ${evaluation.error}`);
  }
  return proofRef;
}

function executedProofKey(proofRef) {
  if (!proofRef || typeof proofRef !== "object" || Array.isArray(proofRef)) {
    return `invalid:${JSON.stringify(proofRef)}`;
  }
  return JSON.stringify({
    kind: String(proofRef.kind || "").trim(),
    artifact: normalizeEvidenceRef(proofRef.artifact),
    selector: String(proofRef.selector || "").trim(),
  });
}

function mergeExecutedProofRefs(existing, additions) {
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new Error("Existing executed_proof_refs must be an array before it can be updated");
  }
  const merged = [];
  const seen = new Set();
  for (const proofRef of [...(existing || []), ...(additions || [])]) {
    const key = executedProofKey(proofRef);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(proofRef);
  }
  return merged;
}

function buildAcceptanceCriteria(storyId, values) {
  return (values || []).map((description, index) => ({
    id: `AC-${storyId}-${String(index + 1).padStart(3, "0")}`,
    description: String(description).trim(),
  })).filter((criterion) => criterion.description);
}

function sanitizeStory(story) {
  const copy = { ...story };
  for (const field of ["code_refs", "test_refs", "doc_refs", "validation_refs", "merged_from", "conflicts", "tags", "acceptance_criteria"]) {
    if (!Array.isArray(copy[field])) copy[field] = [];
  }
  return copy;
}

function findStory(registry, id) {
  return registry.stories.find((story) => normalizeId(story.id) === id);
}

function print(payload, jsonMode) {
  if (jsonMode) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (payload.story) {
    console.log(`${payload.status}: ${payload.story.id} ${payload.story.title}`);
  } else {
    console.log(`${payload.status}: ${payload.count ?? 0} stories`);
  }
}

function commandNew(options) {
  const registry = loadRegistry();
  const title = String(options.title || options._.join(" ") || "").trim();
  if (!title) throw new Error("Story title is required.");
  const id = normalizeId(options.id || nextStoryId(registry.stories || []));
  assertStoryId(id);
  if (findStory(registry, id)) throw new Error(`Story already exists: ${id}`);
  const status = String(options.status || "NOT_IMPLEMENTED").toUpperCase();
  if (!VALID_STATUSES.has(status)) throw new Error(`Invalid status ${status}.`);
  const currentCoverageContractVersion = Number(registry?.coverage_contract?.current_version);

  const story = sanitizeStory({
    id,
    title,
    priority: String(options.priority || "MEDIUM").toUpperCase(),
    status,
    ...(currentCoverageContractVersion === 2 ? { coverage_contract_version: 2 } : {}),
    description: options.description || "",
    code_refs: [],
    test_refs: [],
    doc_refs: [],
    validation_refs: [],
    acceptance_criteria: buildAcceptanceCriteria(id, options.acceptance),
    tags: parseTags(options.tags),
    needs_review: options["needs-review"] === true ? true : false,
    created_at: new Date().toISOString(),
    merged_from: [],
    conflicts: [],
  });

  registry.stories.push(story);
  writeRegistry(registry);
  return { status: "PASS", action: "created", story };
}

function commandList(options) {
  const registry = loadRegistry();
  let stories = Array.isArray(registry.stories) ? registry.stories.map(sanitizeStory) : [];
  if (options.status) {
    const status = String(options.status).toUpperCase();
    stories = stories.filter((story) => String(story.status || "").toUpperCase() === status);
  }
  if (options["needs-review"]) stories = stories.filter((story) => story.needs_review === true);
  return { status: "PASS", count: stories.length, stories };
}

function commandShow(options) {
  const registry = loadRegistry();
  const id = normalizeId(options._[0]);
  assertStoryId(id);
  const story = findStory(registry, id);
  if (!story) throw new Error(`Story not found: ${id}`);
  return { status: "PASS", story: sanitizeStory(story) };
}

function commandUpdate(options) {
  const registry = loadRegistry();
  const id = normalizeId(options._[0]);
  assertStoryId(id);
  const story = findStory(registry, id);
  if (!story) throw new Error(`Story not found: ${id}`);
  const executedProofAdditions = options["executed-proof-ref"]
    ? options["executed-proof-ref"].map(normalizeExecutedProofRef)
    : null;
  if (executedProofAdditions && Number(story.coverage_contract_version) !== 2) {
    throw new Error("--executed-proof-ref is only valid for coverage_contract_version 2 stories");
  }
  if (options.title) story.title = String(options.title).trim();
  if (options.status) {
    const status = String(options.status).toUpperCase();
    if (!VALID_STATUSES.has(status)) throw new Error(`Invalid status ${status}.`);
    story.status = status;
  }
  if (options.acceptance) story.acceptance_criteria = buildAcceptanceCriteria(id, options.acceptance);
  if (options.tags) story.tags = parseTags(options.tags);
  if (options.description !== undefined) story.description = String(options.description);
  if (options["code-ref"]) story.code_refs = mergeEvidenceRefs(story.code_refs, options["code-ref"]);
  if (options["test-ref"]) story.test_refs = mergeEvidenceRefs(story.test_refs, options["test-ref"]);
  if (options["doc-ref"]) story.doc_refs = mergeEvidenceRefs(story.doc_refs, options["doc-ref"]);
  if (options["validation-ref"]) story.validation_refs = mergeEvidenceRefs(story.validation_refs, options["validation-ref"]);
  if (executedProofAdditions) {
    story.executed_proof_refs = mergeExecutedProofRefs(story.executed_proof_refs, executedProofAdditions);
  }
  story.updated_at = new Date().toISOString();
  if (options["dry-run"]) {
    return { status: "PASS", action: "would_update", dry_run: true, story: sanitizeStory(story) };
  }
  writeRegistry(registry);
  return { status: "PASS", action: "updated", story: sanitizeStory(story) };
}

function commandRetire(options) {
  const registry = loadRegistry();
  const id = normalizeId(options._[0]);
  assertStoryId(id);
  const story = findStory(registry, id);
  if (!story) throw new Error(`Story not found: ${id}`);
  story.status = "RETIRED";
  story.retired_at = new Date().toISOString();
  if (options.reason) story.retirement_reason = String(options.reason);
  writeRegistry(registry);
  return { status: "PASS", action: "retired", story: sanitizeStory(story) };
}

function main() {
  const [command = "list", ...rest] = process.argv.slice(2);
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  const options = parseArgs(rest);
  const jsonMode = options.json === true;
  try {
    const result = command === "new" ? commandNew(options)
      : command === "list" ? commandList(options)
        : command === "show" ? commandShow(options)
          : command === "update" ? commandUpdate(options)
            : command === "retire" ? commandRetire(options)
              : null;
    if (!result) throw new Error(`Unknown story command: ${command}`);
    print(result, jsonMode);
  } catch (error) {
    if (jsonMode) {
      emitJson({ status: "FAIL", error: error.message }, { exitCode: 1 });
    } else {
      console.error(`ERROR: ${error.message}`);
      console.error(usage());
      process.exitCode = 1;
    }
  }
}

main();
