#!/usr/bin/env node
// Focused regression coverage for scripts/lib/auditor_pack_engine.mjs.

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  assertStoryFacts,
  formatPhaseGuidance,
  normalizePackFinding,
  runPrologPackAudit,
} from "../scripts/lib/auditor_pack_engine.mjs";
import uxUiPack from "../packs/ux_ui/index.mjs";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`PASS: ${label}`);
  } else {
    failed++;
    console.log(`FAIL: ${label}`);
  }
}

async function scenarioRunsRealPrologQuery() {
  const root = mkdtempSync(join(tmpdir(), "auditor-pack-engine-"));
  try {
    const rulesFile = join(root, "rules.pl");
    writeFileSync(
      rulesFile,
      "engine_violation('EN-001', Subject, 'needs proof', high) :- story(Subject, _, _, _).\n",
    );

    const findings = await runPrologPackAudit({
      storyRegistry: {
        stories: [{
          id: "US-001",
          title: "Prove the engine helper",
          priority: "HIGH",
          status: "ready",
          tags: ["engine"],
        }],
      },
    }, {
      packId: "engine_test",
      rulesFile,
      query: "engine_violation(RuleId, Subject, Detail, Severity)",
      defaultRuleId: "EN-???",
      defaultSeverity: "MEDIUM",
      collectFacts: (context, session) => {
        assertStoryFacts(session, context.storyRegistry, { include: ["tags"], sanitize: (value) => `'${String(value).replace(/'/g, "\\'")}'` });
      },
    });

    assert(findings.length === 1, "runPrologPackAudit returns one finding from real Prolog rule");
    assert(findings[0].ruleId === "EN-001", "runPrologPackAudit maps RuleId binding");
    assert(findings[0].subject === "US-001", "runPrologPackAudit maps Subject binding");
    assert(findings[0].severity === "high", "runPrologPackAudit preserves Prolog severity binding");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioNormalizesErrorAndDowngrade() {
  const errorFinding = normalizePackFinding({ _error: "missing rules" }, {}, {
    packId: "engine_test",
    errorId: "EN-ERR",
    errorRecommendation: "Fix the test rules.",
  });
  assert(errorFinding.id === "EN-ERR", "normalizePackFinding preserves configured error id");
  assert(errorFinding.category === "pack_error", "normalizePackFinding emits pack_error category");

  const normalized = normalizePackFinding({
    ruleId: "EN-001",
    subject: "US-001",
    detail: "needs proof",
    severity: "HIGH",
  }, {
    planShape: { primary: "docs" },
  }, {
    packId: "engine_test",
    rules: [{ id: "EN-001", remediation: "Attach evidence." }],
    category: "engine",
    severityDowngrades: { "EN-001": ["docs"] },
  });

  assert(normalized.severity === "LOW", "normalizePackFinding applies shape-aware downgrade");
  assert(normalized.story_refs.includes("US-001"), "normalizePackFinding keeps default story ref mapping");
  assert(normalized.recommendation === "Attach evidence.", "normalizePackFinding uses rule remediation");
}

function scenarioFormatsPhaseGuidance() {
  const guidance = formatPhaseGuidance({ plan: ["First", "Second"] }, "PLAN");
  assert(guidance === "1. First\n2. Second", "formatPhaseGuidance normalizes phase and numbers lines");
  assert(formatPhaseGuidance({ plan: [] }, "plan") === null, "formatPhaseGuidance suppresses empty guidance");
}

async function scenarioUxUiIgnoresNotImplementedBacklogStories() {
  const findings = await uxUiPack.audit({
    cwd: process.cwd(),
    auditConfig: { roles: ["ux_ui"] },
    storyRegistry: {
      stories: [
        {
          id: "US-UX-BACKLOG",
          title: "Frontend responsive ideation harness",
          priority: "HIGH",
          status: "NOT_IMPLEMENTED",
          tags: ["frontend", "ui"],
          code_refs: [],
          test_refs: [],
        },
        {
          id: "US-UX-ACTIVE",
          title: "Frontend checkout flow",
          priority: "HIGH",
          status: "PARTIALLY_COVERED",
          tags: ["frontend", "ui"],
          code_refs: [],
          test_refs: [],
        },
      ],
    },
  });
  const ux002 = findings.filter((finding) => finding.ruleId === "UX-002");

  assert(
    !ux002.some((finding) => finding.subject === "us-ux-backlog"),
    "ux_ui UX-002 ignores NOT_IMPLEMENTED backlog stories without code refs",
  );
  assert(
    ux002.some((finding) => finding.subject === "us-ux-active"),
    "ux_ui UX-002 still flags active high-priority UX stories without code refs",
  );
}

await scenarioRunsRealPrologQuery();
scenarioNormalizesErrorAndDowngrade();
scenarioFormatsPhaseGuidance();
await scenarioUxUiIgnoresNotImplementedBacklogStories();

console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
