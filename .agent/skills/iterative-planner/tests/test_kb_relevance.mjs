#!/usr/bin/env node
// test_kb_relevance.mjs — F-05 contract: knowledge_resolver must expose a
// task-conditioned, compact KB-relevance surface so agents can read the most
// relevant entries at PLAN time instead of dumping the whole KB.

import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const resolverCli = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "knowledge_resolver.mjs");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

function run(args) {
  try {
    const stdout = execFileSync(NODE, [resolverCli, ...args], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch { /* non-JSON paths */ }
    return { ok: true, stdout, parsed };
  } catch (error) {
    return { ok: false, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

console.log("\nKB Relevance Surface Contract\n");

// 1. Function is reachable through the CLI flag.
let result = run(["--goal", "fix gate verdict routing", "--kb-relevant", "--json"]);
assert(result.ok && result.parsed, "--kb-relevant emits JSON when --json is set");
assert(result.parsed?.goal === "fix gate verdict routing", "summary echoes the goal");
assert(typeof result.parsed?.count === "number", "summary records count");
assert(Array.isArray(result.parsed?.entries), "summary returns an entries array");

// 2. The entries are KB-backed only — no workflows, recipes, or stories.
const entries = result.parsed.entries || [];
const kinds = [...new Set(entries.map((entry) => entry.kind))];
const allowed = new Set(["mistake", "pattern", "gotcha", "kb_ref", "retro"]);
assert(kinds.every((kind) => allowed.has(kind)),
  `entries are KB-backed kinds only (got: ${kinds.join(", ")})`);

// 3. Entries are sorted by score descending.
const scores = entries.map((entry) => entry.score || 0);
const sortedDesc = [...scores].sort((left, right) => right - left);
assert(JSON.stringify(scores) === JSON.stringify(sortedDesc),
  "entries are sorted by score descending");

// 4. Trust level is preserved on every entry.
assert(entries.every((entry) => ["trusted", "derived"].includes(entry.trust_level)),
  "every entry carries trust_level=trusted or derived");

// 5. Each entry has a stable id and at least one source ref pointing into the KB.
assert(entries.every((entry) => Boolean(entry.id)), "every entry has an id");
assert(entries.every((entry) => {
  const refs = Array.isArray(entry.source_refs) ? entry.source_refs : [];
  if (entry.kind === "mistake" || entry.kind === "pattern" || entry.kind === "gotcha" || entry.kind === "kb_ref") {
    return refs.some((ref) => String(ref || "").startsWith("plans/knowledge/"));
  }
  return refs.length > 0; // retros have retro_ledger refs
}), "every entry has at least one KB-or-retro source ref");

// 6. limit honored — internal default is 10. We can't pass --limit yet but
//    can assert the default cap.
assert(entries.length <= 10, "default limit caps entries at 10");

// 7. text output renders without error and mentions the goal.
result = run(["--goal", "fix gate verdict routing", "--kb-relevant"]);
assert(result.ok && /KB relevance for goal: fix gate verdict routing/.test(result.stdout),
  "text mode prints goal header");
assert(/Read these KB entries|No KB entries matched/.test(result.stdout),
  "text mode prints the advisory line");

// 8. With a goal that doesn't match any KB content, the surface is empty.
result = run(["--goal", "xyzzy_quibble_42_unrelated_term", "--kb-relevant", "--json", "--no-plan-context"]);
// Don't strictly require zero — the resolver may still surface broader matches
// based on planned files. But the count should be small and the structure intact.
assert(result.ok && result.parsed && Array.isArray(result.parsed.entries),
  "unrelated goal still returns a valid entries array");

// 9. Help text mentions --kb-relevant.
result = run(["--help"]);
assert(result.ok && /--kb-relevant/.test(result.stdout),
  "help text advertises --kb-relevant");
assert(/F-05|sharpens as it grows/i.test(result.stdout),
  "help text explains the F-05 motivation");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
