#!/usr/bin/env node
// @planner:story_id US-087
// @planner:proves = crit:CRIT-001, crit:CRIT-004

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { spawnSync } from "child_process";

const REGISTRY_RELATIVE_PATH = join("reports", "user_story_audit", "story_registry.json");
const VALID_STATUSES = new Set(["FULLY_COVERED", "PARTIALLY_COVERED", "NOT_IMPLEMENTED", "RETIRED"]);

function usage() {
  return [
    "planner story — canonical story registry writer",
    "",
    "Usage:",
    "  planner story new [title] [--id US-042] [--title \"...\"] [--status NOT_IMPLEMENTED] [--acceptance \"...\"]... [--tags a,b] [--json]",
    "  planner story list [--status FULLY_COVERED] [--needs-review] [--json]",
    "  planner story show <story-id> [--json]",
    "  planner story update <story-id> [--title \"...\"] [--status PARTIALLY_COVERED] [--acceptance \"...\"]... [--tags a,b] [--json]",
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
    if (key === "json" || key === "needs-review") {
      options[key] = true;
      continue;
    }
    const value = inlineValue !== undefined ? inlineValue : argv[++i];
    if (value === undefined) throw new Error(`Missing value for --${key}`);
    if (key === "acceptance") {
      options.acceptance = options.acceptance || [];
      options.acceptance.push(value);
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
  if (!/^(US|D|FEAT)-[0-9]{3,}$/.test(id)) {
    throw new Error(`Invalid story id ${JSON.stringify(id)}; expected US-NNN, D-NNN, or FEAT-NNN.`);
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

  const story = sanitizeStory({
    id,
    title,
    priority: String(options.priority || "MEDIUM").toUpperCase(),
    status,
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
  if (options.title) story.title = String(options.title).trim();
  if (options.status) {
    const status = String(options.status).toUpperCase();
    if (!VALID_STATUSES.has(status)) throw new Error(`Invalid status ${status}.`);
    story.status = status;
  }
  if (options.acceptance) story.acceptance_criteria = buildAcceptanceCriteria(id, options.acceptance);
  if (options.tags) story.tags = parseTags(options.tags);
  if (options.description !== undefined) story.description = String(options.description);
  story.updated_at = new Date().toISOString();
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
      console.log(JSON.stringify({ status: "FAIL", error: error.message }, null, 2));
    } else {
      console.error(`ERROR: ${error.message}`);
      console.error(usage());
    }
    process.exit(1);
  }
}

main();
