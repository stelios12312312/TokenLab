#!/usr/bin/env node
// test_host_rule_overlays.mjs — Unit tests for host rule overlay extraction.
// @planner:module = host_rule_overlays
// @planner:story = US-015
// @planner:proves = host_rule_overlay_extraction

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  classifyRulesMdDivergence,
  extractHostRuleOverlays,
  listHostRuleOverlayFiles,
  parseNumberedMarkdownSections,
  planHostRuleOverlayWrites,
} from "../scripts/lib/host_rule_overlays.mjs";

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

console.log("\nHost Rule Overlays Unit Tests\n");

const sampleSource = `# Agent Rules

Mandatory rules for every AI session on this project.

---

## 0. Use the Iterative Planner — Don't Plan Ad-hoc

**Goal**: Ensure all non-trivial work goes through the structured state machine.

**Protocol**:
- Before doing anything: check for an active plan.

---

## 1. Memory First / Memory Last

**Goal**: Accumulated knowledge must be used.

**Protocol**:
- Session Start: Read plans/knowledge/index.md.
`;

const sampleConsumerExtra = `# Agent Rules

Mandatory rules for every AI session on this project.

---

## 0. Use the Iterative Planner — Don't Plan Ad-hoc

**Goal**: Ensure all non-trivial work goes through the structured state machine.

**Protocol**:
- Before doing anything: check for an active plan.

---

## 1. Memory First / Memory Last

**Goal**: Accumulated knowledge must be used.

**Protocol**:
- Session Start: Read plans/knowledge/index.md.

---

## 5. Tender Integrity

**Goal**: Never accept corrupted bid submissions.

**Protocol**:
- Check sha256 before ingestion.
- Reject unsigned envelopes.
`;

const sampleCanonicalSourceWithDomain = `# Agent Rules

---

## 0. First Rule

Body 0

---

## 13. Quant Optimizer Scale Disclosure

Body 13

---

<!-- DOMAIN: PROJECT-SPECIFIC RULES
     ============================
     Add rules specific to your project below.
-->

## 14. Explicit Approval for External Communications

Body 14

---

## 15. Measurement Receipts

Body 15
`;

const sampleTenderCopilotShape = `# Agent Rules

---

## 0. First Rule

Body 0

---

## 13. Quant Optimizer Scale Disclosure

Body 13

---

<!-- DOMAIN: PROJECT-SPECIFIC RULES
     ============================
     Add rules specific to your project below.
-->

## 5. Tender Integrity

**Goal**: Never accept corrupted bids.

**Protocol**:
- Reject malformed payloads immediately.

---

## 14. Explicit Approval for External Communications

Body 14

---

## 15. Measurement Receipts

Body 15
`;

// Test 1: identical source/consumer -> identical
{
  const result = classifyRulesMdDivergence({
    sourceText: sampleSource,
    consumerText: sampleSource,
  });
  assert(result.status === "identical", "1. identical source/consumer returns identical status");
  assert(Array.isArray(result.extra_sections) && result.extra_sections.length === 0, "1. identical has 0 extra sections");
}

// Test 2: extra host section only -> extractable; planned file .agent/rules/40-tender-integrity.md
{
  const result = classifyRulesMdDivergence({
    sourceText: sampleSource,
    consumerText: sampleConsumerExtra,
  });
  assert(result.status === "extractable", "2. extra host section only returns extractable");
  assert(result.extra_sections.length === 1, "2. extra host section count is 1");
  assert(result.extra_sections[0].heading.includes("## 5. Tender Integrity"), "2. extra section heading matches");

  const planned = planHostRuleOverlayWrites({
    extra_sections: result.extra_sections,
    overlayDir: "/tmp/fake-repo/.agent/rules",
  });
  assert(planned.length === 1, "2. planned writes length is 1");
  assert(planned[0].relative_path === ".agent/rules/40-tender-integrity.md", "2. planned file path is .agent/rules/40-tender-integrity.md");
  assert(planned[0].contents.includes("## 5. Tender Integrity"), "2. planned contents include heading");
  assert(planned[0].contents.includes("Never accept corrupted bid submissions."), "2. planned contents include body");
  assert(planned[0].contents.endsWith("\n"), "2. planned contents end with trailing newline");
}

// Test 3: edited managed section body -> true_divergence
{
  const editedConsumer = sampleSource.replace(
    "**Goal**: Accumulated knowledge must be used.",
    "**Goal**: Modified knowledge rule body.",
  );
  const result = classifyRulesMdDivergence({
    sourceText: sampleSource,
    consumerText: editedConsumer,
  });
  assert(result.status === "true_divergence", "3. edited managed section body returns true_divergence");
}

// Test 4: deleted managed heading -> true_divergence
{
  const deletedHeadingConsumer = `# Agent Rules\n\n## 0. Use the Iterative Planner — Don't Plan Ad-hoc\n\n**Goal**: Ensure all non-trivial work goes through the structured state machine.\n`;
  const result = classifyRulesMdDivergence({
    sourceText: sampleSource,
    consumerText: deletedHeadingConsumer,
  });
  assert(result.status === "true_divergence", "4. deleted managed heading returns true_divergence");
}

// Test 5: existing overlay file with different content -> do not overwrite (true_divergence / conflict)
{
  const tmp = mkdtempSync(join(tmpdir(), "host-rules-test-conflict-"));
  try {
    const rulesDir = join(tmp, ".agent", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(tmp, ".agent", "rules.md"), sampleConsumerExtra);
    writeFileSync(
      join(rulesDir, "40-tender-integrity.md"),
      "## 5. Tender Integrity\n\nOld conflicting content that should not be clobbered.\n",
    );

    const result = extractHostRuleOverlays(tmp, {
      dryRun: false,
      sourceText: sampleSource,
    });
    assert(result.status === "true_divergence", "5. conflicting existing overlay stops as true_divergence");
    const surviving = readFileSync(join(rulesDir, "40-tender-integrity.md"), "utf-8");
    assert(surviving.includes("Old conflicting content"), "5. existing overlay content was preserved byte-for-byte");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Test 6: canonical-like file that has content after DOMAIN comment matching source, plus one extra host section
{
  const tmp = mkdtempSync(join(tmpdir(), "host-rules-test-tender-copilot-"));
  try {
    mkdirSync(join(tmp, ".agent"), { recursive: true });
    writeFileSync(join(tmp, ".agent", "rules.md"), sampleTenderCopilotShape);

    const dryResult = extractHostRuleOverlays(tmp, {
      dryRun: true,
      sourceText: sampleCanonicalSourceWithDomain,
    });
    assert(dryResult.status === "extractable", "6. tender-copilot shape dry run returns extractable");
    assert(dryResult.wrote.includes(".agent/rules/40-tender-integrity.md"), "6. dry run reports would extract 40-tender-integrity.md");
    assert(!existsSync(join(tmp, ".agent", "rules", "40-tender-integrity.md")), "6. dry run does not write file to disk");

    const writeResult = extractHostRuleOverlays(tmp, {
      dryRun: false,
      sourceText: sampleCanonicalSourceWithDomain,
    });
    assert(writeResult.status === "extractable", "6. tender-copilot shape write returns extractable");
    assert(existsSync(join(tmp, ".agent", "rules", "40-tender-integrity.md")), "6. write creates 40-tender-integrity.md on disk");

    const writtenContent = readFileSync(join(tmp, ".agent", "rules", "40-tender-integrity.md"), "utf-8");
    assert(writtenContent.includes("## 5. Tender Integrity"), "6. written overlay contains heading");
    assert(writtenContent.includes("Never accept corrupted bids."), "6. written overlay contains body");

    const overlays = listHostRuleOverlayFiles(tmp);
    assert(overlays.length === 1, "6. listHostRuleOverlayFiles returns 1 file");
    assert(overlays[0].endsWith("40-tender-integrity.md"), "6. listHostRuleOverlayFiles returns absolute path to overlay");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Test 7: missing or unreadable sourceText -> true_divergence, no writes
{
  const tmp = mkdtempSync(join(tmpdir(), "host-rules-test-missing-source-"));
  try {
    mkdirSync(join(tmp, ".agent"), { recursive: true });
    writeFileSync(join(tmp, ".agent", "rules.md"), sampleConsumerExtra);

    const resultNull = extractHostRuleOverlays(tmp, {
      dryRun: false,
      sourceText: null,
    });
    assert(resultNull.status === "true_divergence", "7. null sourceText returns true_divergence");
    assert(resultNull.wrote.length === 0, "7. null sourceText writes 0 files");
    assert(!existsSync(join(tmp, ".agent", "rules")), "7. no rules directory created for null sourceText");

    const classResult = classifyRulesMdDivergence({
      sourceText: null,
      consumerText: sampleConsumerExtra,
    });
    assert(classResult.status === "true_divergence", "7. classify with null sourceText returns true_divergence");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Test 8: managed body with extra space, plus new host section -> true_divergence, no overlay write
{
  const tmp = mkdtempSync(join(tmpdir(), "host-rules-test-space-edit-"));
  try {
    mkdirSync(join(tmp, ".agent"), { recursive: true });
    // Add extra space inside managed rule 0 body
    const spaceEditedConsumer = sampleConsumerExtra.replace(
      "Ensure all non-trivial work",
      "Ensure  all non-trivial work",
    );
    writeFileSync(join(tmp, ".agent", "rules.md"), spaceEditedConsumer);

    const classResult = classifyRulesMdDivergence({
      sourceText: sampleSource,
      consumerText: spaceEditedConsumer,
    });
    assert(classResult.status === "true_divergence", "8. managed body with extra space plus host section returns true_divergence");

    const writeResult = extractHostRuleOverlays(tmp, {
      dryRun: false,
      sourceText: sampleSource,
    });
    assert(writeResult.status === "true_divergence", "8. extract with whitespace edit returns true_divergence");
    assert(writeResult.wrote.length === 0, "8. extract with whitespace edit writes 0 files");
    assert(!existsSync(join(tmp, ".agent", "rules")), "8. no overlay written when managed body has extra space");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

