#!/usr/bin/env node
// test_markdown_table_parser.mjs — shared markdown table parser regressions.

import assert from "assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  isMarkdownTableSeparatorRow,
  parseMarkdownTable,
  splitMarkdownTableRow,
} from "../scripts/lib/markdown_table.mjs";
import { serializeToFacts } from "../scripts/ontology_serializer.mjs";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL: ${name}`);
    console.log(`        ${error.message}`);
  }
}

test("inline-code pipes do not split cells", () => {
  const row = splitMarkdownTableRow("| Source version | `rg -n \"5\\\\.1\\\\.7|planner_version\" .agent` | PASS | evidence |");
  assert.deepStrictEqual(row, [
    "Source version",
    "`rg -n \"5\\\\.1\\\\.7|planner_version\" .agent`",
    "PASS",
    "evidence",
  ]);
});

test("escaped pipes stay in the cell value", () => {
  const row = splitMarkdownTableRow("| A | escaped \\| pipe | PASS |");
  assert.deepStrictEqual(row, ["A", "escaped | pipe", "PASS"]);
});

test("separator rows are recognized after parsing", () => {
  assert.equal(isMarkdownTableSeparatorRow("|---|:---:|---:|"), true);
  assert.equal(isMarkdownTableSeparatorRow("| command | `a|b` | PASS |"), false);
});

test("malformed rows retain provenance", () => {
  const parsed = parseMarkdownTable(`
| Criterion | Command | Result |
|---|---|---|
| Good | \`a|b\` | PASS |
| Shifted | raw | PASS | extra |
`, { sourceLine: 10 });

  assert.deepStrictEqual(parsed.header, ["Criterion", "Command", "Result"]);
  assert.equal(parsed.rows[0][1], "`a|b`");
  assert.equal(parsed.malformed_rows.length, 1);
  assert.equal(parsed.malformed_rows[0].line_number, 14);
  assert.equal(parsed.malformed_rows[0].expected_cells, 3);
  assert.equal(parsed.malformed_rows[0].actual_cells, 4);
});

test("ontology verification facts use shared inline-pipe parsing", () => {
  const tmp = mkdtempSync(join(tmpdir(), "markdown-table-ontology-"));
  try {
    const planDir = join(tmp, "plans", "plan_2026-05-01_inline_pipe");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "verification.md"), `# Verification

## Criteria Verification
| Criterion | Command | Result | Evidence |
|---|---|---|---|
| Source version marker check passes for \`7.0.1\` | \`rg -n "7\\\\.0\\\\.1|planner_version" .agent\` | PASS | version marker found |
`);

    const { facts } = serializeToFacts({
      cwd: tmp,
      storyRegistry: { stories: [] },
      planDir,
      planContent: "",
      annotations: [],
    });
    const verificationFacts = facts.split("\n").filter((fact) => fact.startsWith("verification_result("));
    assert.equal(verificationFacts.length, 1);
    assert.match(verificationFacts[0], /,\s*true,\s*/);
    assert.doesNotMatch(verificationFacts[0], /,\s*false,\s*/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
