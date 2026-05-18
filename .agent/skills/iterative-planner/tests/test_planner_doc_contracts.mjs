#!/usr/bin/env node
// test_planner_doc_contracts.mjs
// Contract checks for high-priority workflow and skill surfaces that are
// documentation-first rather than script-first.

import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const plannerRoot = resolve(testDir, "..", "..", "..", "..");

const rootClaudeDoc = readFileSync(join(plannerRoot, "CLAUDE.md"), "utf-8");
const rootGeminiDoc = readFileSync(join(plannerRoot, "GEMINI.md"), "utf-8");
const rootAgentsDoc = readFileSync(join(plannerRoot, "AGENTS.md"), "utf-8");
const skillDoc = readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/SKILL.md"), "utf-8");
const quickstartDoc = readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/QUICKSTART.md"), "utf-8");
const errorRecoveryDoc = readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/ERROR-RECOVERY.md"), "utf-8");
const edgeCasesDoc = readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/EDGE-CASES.md"), "utf-8");
const migrationDoc = readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/MIGRATION.md"), "utf-8");
const rulesDoc = readFileSync(join(plannerRoot, ".agent/rules.md"), "utf-8");
const ruleEngineGuideDoc = readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/references/rule-engine-guide.md"), "utf-8");
const fileFormatsDoc = readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/references/file-formats.md"), "utf-8");
const programGatesConfig = readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/config/program_gates.json"), "utf-8");
const programPacketSchema = readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/config/program_packet.schema.json"), "utf-8");
const wordpressChecklistDoc = readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/checklists/domains/wordpress.yaml"), "utf-8");
const claudeTemplateDoc = readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/references/CLAUDE.template.md"), "utf-8");
const safePlanDoc = readFileSync(join(plannerRoot, ".agent/workflows/safe-plan.md"), "utf-8");
const safeChangeDoc = readFileSync(join(plannerRoot, ".agent/workflows/safe-change.md"), "utf-8");
const safeChangePowerDoc = readFileSync(join(plannerRoot, ".agent/workflows/safe-change-power.md"), "utf-8");
const advisorDoc = readFileSync(join(plannerRoot, ".agent/workflows/advisor.md"), "utf-8");
const programManagerDoc = readFileSync(join(plannerRoot, ".agent/workflows/program-manager.md"), "utf-8");
const roadmapStewardDoc = readFileSync(join(plannerRoot, ".agent/workflows/roadmap-steward.md"), "utf-8");
const recipeDiscoveryDoc = readFileSync(join(plannerRoot, ".agent/workflows/recipe-discovery.md"), "utf-8");
const recipeTidyDoc = readFileSync(join(plannerRoot, ".agent/workflows/recipe-tidy.md"), "utf-8");
const recipeBootstrapDoc = readFileSync(join(plannerRoot, ".agent/workflows/recipe-bootstrap.md"), "utf-8");
const storyBootstrapDoc = readFileSync(join(plannerRoot, ".agent/workflows/story-bootstrap.md"), "utf-8");
const stewardDoc = readFileSync(join(plannerRoot, ".agent/workflows/steward.md"), "utf-8");
const smeImprovementDoc = readFileSync(join(plannerRoot, ".agent/workflows/sme-improvement.md"), "utf-8");
const migrateAllDoc = readFileSync(join(plannerRoot, ".agent/workflows/migrate-all.md"), "utf-8");
const redTeamAuditDoc = readFileSync(join(plannerRoot, ".agent/workflows/red-team-audit.md"), "utf-8");
const regressionAuditDoc = readFileSync(join(plannerRoot, ".agent/workflows/regression-audit.md"), "utf-8");
const userStoryAuditDoc = readFileSync(join(plannerRoot, ".agent/workflows/red-team-user-story-audit.md"), "utf-8");
const retroDoc = readFileSync(join(plannerRoot, ".agent/workflows/retro.md"), "utf-8");
const consolidateAnnotationsDoc = readFileSync(join(plannerRoot, ".agent/workflows/consolidate-annotations.md"), "utf-8");
const housekeepingDoc = readFileSync(join(plannerRoot, ".agent/workflows/housekeeping.md"), "utf-8");
const remediationDoc = readFileSync(join(plannerRoot, ".agent/skills/red-team-remediation/SKILL.md"), "utf-8");
const multiAgentDoc = readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/references/multi-agent-operating-model.md"), "utf-8");
const readmeDoc = readFileSync(join(plannerRoot, "README.md"), "utf-8");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

function assertIncludes(doc, needle, label) {
  assert(doc.includes(needle), label);
}

function assertNotIncludes(doc, needle, label) {
  assert(!doc.includes(needle), label);
}

function extractLevelTwoSection(doc, heading) {
  const text = String(doc || "").replace(/\r\n/g, "\n");
  const start = text.indexOf(heading);
  if (start === -1) return null;
  const regex = /^##\s+/gm;
  regex.lastIndex = start + heading.length;
  let end = text.length;
  let match;
  while ((match = regex.exec(text))) {
    if (match.index > start) {
      end = match.index;
      break;
    }
  }
  return text
    .slice(start, end)
    .replace(/\n?<!-- END ITERATIVE-PLANNER MANAGED SNAPSHOT -->\s*$/u, "")
    .trim();
}

console.log("\nPlanner Documentation Contracts\n");

// US-028 Drift detection
assertIncludes(
  skillDoc,
  "#### Drift Detection Gate (every 15 tool calls during EXECUTE)",
  "SKILL.md documents the drift detection gate cadence"
);
assertIncludes(
  skillDoc,
  "If 3+ drift warnings accumulate",
  "SKILL.md documents the drift escalation threshold"
);

// US-029 Autonomy leash
assertIncludes(
  skillDoc,
  "## Autonomy Leash (CRITICAL)",
  "SKILL.md documents the autonomy leash section"
);
assertIncludes(
  readmeDoc,
  "Autonomy leash",
  "README keeps the autonomy leash visible in the public planner surface"
);
assertIncludes(
  readmeDoc,
  "suggested_attack_vectors",
  "README documents ontology-backed suggested attack vectors in the public planner surface"
);
assertIncludes(
  readmeDoc,
  "node .agent/skills/iterative-planner/scripts/planner_hygiene.mjs scan --compact",
  "README documents the compact planner hygiene entrypoint"
);
assertIncludes(
  readmeDoc,
  "node .agent/skills/iterative-planner/scripts/planner_hygiene.mjs fix-safe --write",
  "README documents the deterministic planner hygiene fix path"
);
assertIncludes(
  skillDoc,
  "node .agent/skills/iterative-planner/tests/test_bootstrap_state_surface.mjs",
  "SKILL.md documents the bootstrap smoke suite for sensitive planner-core surfaces"
);
assertIncludes(
  skillDoc,
  "node .agent/skills/iterative-planner/tests/test_archetype_preflight_scenarios.mjs",
  "SKILL.md documents the archetype preflight scenario suite for sensitive planner-core surfaces"
);
assertIncludes(
  skillDoc,
  "node .agent/skills/iterative-planner/tests/test_archetype_gate_canonicalization.mjs",
  "SKILL.md documents the gate canonicalization suite for sensitive planner-core surfaces"
);
assertIncludes(
  skillDoc,
  "Planner-Core Contract Debug Packet",
  "SKILL.md documents the deterministic planner-core debug packet"
);
assertIncludes(
  skillDoc,
  "node <skill-path>/scripts/planner_findings.mjs --dir <repo-root> --plan <plan-dir> --gate <gate> --json",
  "SKILL.md teaches planner-core debugging through planner_findings before parser edits"
);
assertIncludes(
  skillDoc,
  "_PLANNER_PLAN_TARGET=<plan-dir> node <skill-path>/scripts/ontology_serializer.mjs --json",
  "SKILL.md teaches planner-core debugging through the target plan ontology serializer output"
);
assertIncludes(
  skillDoc,
  "planner_findings.mjs",
  "SKILL.md documents the deterministic planner findings script"
);
assertIncludes(
  skillDoc,
  "`anti_ritual`",
  "SKILL.md documents the shared anti_ritual routing surface"
);
assertIncludes(
  skillDoc,
  "adversarial_profile",
  "SKILL.md documents the shared adversarial profile surface"
);
assertIncludes(
  skillDoc,
  "suggested_attack_vectors",
  "SKILL.md documents the ontology-backed suggested attack vectors"
);
assertIncludes(
  skillDoc,
  "planner_hygiene.mjs",
  "SKILL.md documents the compact planner hygiene script"
);
assertIncludes(
  skillDoc,
  "node <skill-path>/scripts/planner_hygiene.mjs scan --json",
  "SKILL.md documents the machine-readable planner hygiene scan command"
);
assertIncludes(
  skillDoc,
  "node <skill-path>/scripts/planner_hygiene.mjs fix-safe --write",
  "SKILL.md documents the deterministic planner hygiene write path"
);
assertIncludes(
  skillDoc,
  "gitignored `.env.local`",
  "SKILL.md documents local env fallback for drift LLM config"
);
assertIncludes(
  skillDoc,
  "DEEPSEEK_API_KEY",
  "SKILL.md documents the DeepSeek key alias for drift LLM config"
);
assertIncludes(
  skillDoc,
  "missing semantic substrate",
  "SKILL.md documents semantic-substrate findings in planner_findings"
);
assertIncludes(
  skillDoc,
  "proof_telemetry",
  "SKILL.md documents the proof_telemetry feature flag"
);
assertIncludes(
  skillDoc,
  "config/planner_manifesto.json",
  "SKILL.md documents the planner manifesto as the machine-readable north star"
);
assertIncludes(
  skillDoc,
  "warnings stay advisory unless they are backed by real semantic/proof/integrity risk",
  "SKILL.md documents the mixed anti-ritual enforcement rule"
);
assertIncludes(
  skillDoc,
  "references/planner-manifesto.md",
  "SKILL.md documents the planner manifesto mirror reference"
);
assertIncludes(
  advisorDoc,
  "### Anti-Ritual Lens",
  "/advisor documents the anti-ritual interpretation section"
);
assertIncludes(
  advisorDoc,
  "the `anti_ritual.recommended_action`",
  "/advisor tells operators to follow the anti_ritual recommended action"
);
assertIncludes(
  advisorDoc,
  "draft_promotion_contract.active",
  "/advisor documents the reviewed-draft promotion contract"
);
assertIncludes(
  advisorDoc,
  "node .agent/skills/iterative-planner/scripts/program_manager.mjs check --json",
  "/advisor gathers Program Packet status"
);
assertIncludes(
  advisorDoc,
  "recommend `/program-manager`",
  "/advisor routes concrete roadmap programs to /program-manager"
);
assertIncludes(
  advisorDoc,
  "recommend `/ticket-traceability-repair`",
  "/advisor routes existing ticket traceability blockers to /ticket-traceability-repair"
);
assertIncludes(
  advisorDoc,
  "`needs_story`, `ticket_without_traceability`, missing `story_refs`",
  "/advisor names the deterministic ticket traceability blocker language"
);
assertIncludes(
  programManagerDoc,
  "# /program-manager Workflow",
  "/program-manager workflow keeps its canonical heading"
);
assertIncludes(
  programManagerDoc,
  "plans/programs/<program-id>/program_packet.json",
  "/program-manager documents the canonical Program Packet path"
);
assertIncludes(
  programManagerDoc,
  "validate-to-program-close",
  "/program-manager documents the program close gate"
);
assertIncludes(
  programManagerDoc,
  "Migration tickets require `compatibility_contract_refs`",
  "/program-manager documents migration compatibility safeguards"
);
assertIncludes(
  programManagerDoc,
  "GitHub Issue/Project item -> Program Packet ticket -> child plan -> verification row -> GitHub status/comment update",
  "/program-manager documents GitHub tickets as Program Packet mirrors"
);
assertIncludes(
  programManagerDoc,
  "DeepSeek or another cheap reviewer",
  "/program-manager documents advisory DeepSeek ticket review"
);
assertIncludes(
  programManagerDoc,
  "It must not mark a ticket `verified`",
  "/program-manager keeps LLM ticket review advisory"
);
assertIncludes(
  programManagerDoc,
  "github_ticket_review.mjs review --issue <n>",
  "/program-manager documents the executable GitHub issue review command"
);
assertIncludes(
  programManagerDoc,
  "github_ticket_review.mjs review --project-item <project-item-id-or-url>",
  "/program-manager documents the executable GitHub Project item review command"
);
assertIncludes(
  programManagerDoc,
  "`--write` is required for Program Packet edits",
  "/program-manager documents dry-run/write safety for ticket review"
);
assertIncludes(
  programManagerDoc,
  "program_manager.mjs intake --program <program-id-or-path>",
  "/program-manager documents the Program Manager intake command"
);
assertIncludes(
  programManagerDoc,
  "program_manager.mjs init --program <program-id>",
  "/program-manager documents Program Packet init"
);
assertIncludes(
  programManagerDoc,
  "--auto-story",
  "/program-manager documents auto-story intake"
);
assertIncludes(
  programManagerDoc,
  "--ticket-type",
  "/program-manager documents specialized ticket lanes"
);
assertIncludes(
  programManagerDoc,
  "--persona-review",
  "/program-manager documents persona review intake"
);
assertIncludes(
  programManagerDoc,
  "code_refactor",
  "/program-manager documents code refactor ticket lanes"
);
assertIncludes(
  programManagerDoc,
  "--remediate",
  "/program-manager documents remediation task packets"
);
assertIncludes(
  programManagerDoc,
  "github_ticket_review.mjs publish --program <program-id-or-path>",
  "/program-manager documents explicit GitHub publication"
);
assertIncludes(
  programManagerDoc,
  "`--close-github-issue`",
  "/program-manager documents explicit issue-close safety"
);
assertIncludes(
  programManagerDoc,
  "GitHub comments/status must surface deterministic failures",
  "/program-manager documents deterministic status authority over DeepSeek"
);
assertIncludes(
  programManagerDoc,
  "Ticket Intake Receipt",
  "/program-manager documents the Ticket Intake Receipt"
);
assertIncludes(
  programManagerDoc,
  "retro_recurrence_check",
  "/program-manager documents the retro recurrence check in intake packets"
);
assertIncludes(
  programManagerDoc,
  "quant_persona_gate",
  "/program-manager documents the quant persona gate in intake packets"
);
assertIncludes(
  programManagerDoc,
  "Retro Recurrence Check",
  "/program-manager documents recurrence checks in GitHub review comments"
);
assertIncludes(
  programManagerDoc,
  "Quant Persona Gate",
  "/program-manager documents quant persona checks in GitHub review comments"
);
assertIncludes(
  programManagerDoc,
  "Do not create GitHub tickets directly",
  "/program-manager blocks direct GitHub ticket creation before local intake"
);
assertIncludes(
  skillDoc,
  "github_ticket_review.mjs review --issue <n>",
  "SKILL.md documents the GitHub issue ticket review command"
);
assertIncludes(
  skillDoc,
  "program_manager.mjs intake --program <program-id-or-path>",
  "SKILL.md documents Program Manager idea intake"
);
assertIncludes(
  skillDoc,
  "program_manager.mjs init --program <program-id>",
  "SKILL.md documents Program Packet init"
);
assertIncludes(
  skillDoc,
  "--auto-story",
  "SKILL.md documents auto-story intake"
);
assertIncludes(
  skillDoc,
  "--ticket-type",
  "SKILL.md documents specialized ticket lanes"
);
assertIncludes(
  skillDoc,
  "--persona-review",
  "SKILL.md documents persona review intake"
);
assertIncludes(
  skillDoc,
  "quant_exploration",
  "SKILL.md documents quant exploration ticket lanes"
);
assertIncludes(
  skillDoc,
  "--remediate",
  "SKILL.md documents remediation task packets"
);
assertIncludes(
  skillDoc,
  "Ticket Intake Receipt",
  "SKILL.md documents the Ticket Intake Receipt"
);
assertIncludes(
  skillDoc,
  "retro_recurrence_check",
  "SKILL.md documents recurrence checks for ticket intake"
);
assertIncludes(
  skillDoc,
  "quant_persona_gate",
  "SKILL.md documents quant persona gate checks for ticket intake"
);
assertIncludes(
  skillDoc,
  "Do not create GitHub tickets directly",
  "SKILL.md blocks direct GitHub ticket creation before local intake"
);
assertIncludes(
  skillDoc,
  "github_ticket_review.mjs publish --program <program-id-or-path>",
  "SKILL.md documents explicit GitHub publish"
);
assertIncludes(
  skillDoc,
  "`review_artifacts`, `github_sync`, and deterministic `last_review_status`",
  "SKILL.md documents ticket review metadata fields"
);
assertIncludes(
  roadmapStewardDoc,
  "`/roadmap-steward` is an alias for `/program-manager`",
  "/roadmap-steward documents alias semantics"
);
assertIncludes(
  fileFormatsDoc,
  "## plans/programs/<program-id>/program_packet.json",
  "file-formats.md documents Program Packet artifacts"
);
assertIncludes(
  fileFormatsDoc,
  "state.json.program_context",
  "file-formats.md documents optional child-plan program context"
);
assertIncludes(
  fileFormatsDoc,
  "external_refs",
  "file-formats.md documents Program Packet external_refs metadata"
);
assertIncludes(
  fileFormatsDoc,
  "review_artifacts",
  "file-formats.md documents Program Packet review_artifacts metadata"
);
assertIncludes(
  fileFormatsDoc,
  "ticket_type",
  "file-formats.md documents Program Packet specialized ticket_type"
);
assertIncludes(
  fileFormatsDoc,
  "persona_review_status",
  "file-formats.md documents persona review receipt fields"
);
assertIncludes(
  fileFormatsDoc,
  "retro_recurrence_status",
  "file-formats.md documents recurrence receipt fields"
);
assertIncludes(
  fileFormatsDoc,
  "quant_persona_gate_status",
  "file-formats.md documents quant persona gate receipt fields"
);
assertIncludes(
  fileFormatsDoc,
  "program_manager.mjs init --program",
  "file-formats.md documents Program Packet init"
);
assertIncludes(
  fileFormatsDoc,
  "--auto-story",
  "file-formats.md documents auto-story intake"
);
assertIncludes(
  fileFormatsDoc,
  "remediation_<timestamp>.json",
  "file-formats.md documents remediation task packets"
);
assertIncludes(
  fileFormatsDoc,
  "github_sync",
  "file-formats.md documents Program Packet github_sync metadata"
);
assertIncludes(
  fileFormatsDoc,
  "last_review_status",
  "file-formats.md documents deterministic last_review_status metadata"
);
assertIncludes(
  programPacketSchema,
  "\"external_refs\"",
  "Program Packet schema names external_refs"
);
assertIncludes(
  programPacketSchema,
  "\"ticket_type\"",
  "Program Packet schema names ticket_type"
);
assertIncludes(
  programPacketSchema,
  "\"persona_review\"",
  "Program Packet schema names persona_review"
);
assertIncludes(
  programPacketSchema,
  "\"review_artifacts\"",
  "Program Packet schema names review_artifacts"
);
assertIncludes(
  programPacketSchema,
  "\"github_sync\"",
  "Program Packet schema names github_sync"
);
assertIncludes(
  programPacketSchema,
  "\"last_review_status\"",
  "Program Packet schema names last_review_status"
);
assertIncludes(
  ruleEngineGuideDoc,
  "prolog/programs.pl",
  "rule-engine guide documents program ontology rules"
);
assertIncludes(
  skillDoc,
  "### Program Manager Layer",
  "SKILL.md documents the Program Manager layer"
);
assertIncludes(
  safePlanDoc,
  "use `/program-manager` first",
  "/safe-plan routes roadmap decomposition to /program-manager"
);
assertIncludes(
  safeChangeDoc,
  "state.json.program_context",
  "/safe-change carries Program Packet child-plan context"
);
assertIncludes(
  safeChangePowerDoc,
  "Program Packet migration",
  "/safe-change-power treats Program Packet migration tickets as stronger-wrapper work"
);
assertIncludes(
  safeChangePowerDoc,
  "surface the Ticket Intake Receipt",
  "/safe-change-power tells ticket-shaped work to surface the intake receipt"
);
assertIncludes(
  rootClaudeDoc,
  "| `/program-manager` | `.agent/workflows/program-manager.md` |",
  "CLAUDE.md advertises /program-manager"
);
assertIncludes(
  rootClaudeDoc,
  "## Ticket Intake Compliance",
  "CLAUDE.md documents ticket intake compliance"
);
assertIncludes(
  rootClaudeDoc,
  "Do not create GitHub tickets directly",
  "CLAUDE.md blocks direct GitHub ticket creation before local intake"
);
assertIncludes(
  programGatesConfig,
  "design-to-ready",
  "program_gates.json defines design-to-ready"
);
assertIncludes(
  programPacketSchema,
  "compatibility_contracts",
  "program_packet.schema.json defines compatibility contracts"
);
assertIncludes(
  migrationDoc,
  "## Additive Rollout Note — Shared Transition Refresh",
  "MIGRATION.md records the additive shared-transition-refresh rollout note"
);
assertIncludes(
  migrationDoc,
  "--draft-candidates plans/knowledge/draft_candidates.review.json",
  "MIGRATION.md documents the reviewed draft-candidate promotion command"
);
assertIncludes(
  fileFormatsDoc,
  "## plans/knowledge/draft_candidates.review.json",
  "file-formats.md documents the reviewed draft-candidate staging surface"
);
assertIncludes(
  fileFormatsDoc,
  "promote-knowledge . --draft-candidates plans/knowledge/draft_candidates.review.json --write --json",
  "file-formats.md documents the additive reviewed draft promotion command"
);
assertIncludes(
  safeChangePowerDoc,
  "knowledge_resolver.draft_promotion_contract.active",
  "/safe-change-power documents the reviewed draft promotion contract"
);
assertIncludes(
  claudeTemplateDoc,
  "Prefer the lightest valid flow that still preserves semantic correctness.",
  "CLAUDE.template.md teaches the lightest-valid-flow anti-ritual rule"
);
assertIncludes(
  rootClaudeDoc,
  "Warnings stay visible and actionable, but treat them as advisory unless they are backed by real semantic, proof, or integrity risk.",
  "CLAUDE.md teaches the advisory-warning anti-ritual rule"
);

// US-033 /safe-change workflow
assertIncludes(
  safePlanDoc,
  "# /safe-plan Workflow",
  "/safe-plan workflow keeps its canonical heading"
);
assertIncludes(
  safePlanDoc,
  "node .agent/skills/iterative-planner/scripts/recipe_resolver.mjs --goal \"<task>\" --json",
  "/safe-plan checks deterministic recipe routing before planner sizing"
);
assertIncludes(
  safePlanDoc,
  "node .agent/skills/iterative-planner/scripts/planner_preflight.mjs --goal \"<task>\" --json",
  "/safe-plan reuses the shared planner preflight"
);
assertIncludes(
  safePlanDoc,
  "node .agent/skills/iterative-planner/scripts/knowledge_resolver.mjs --goal \"<task>\" --json",
  "/safe-plan compiles the shared discovery contract before drafting"
);
assertIncludes(
  safePlanDoc,
  "node <skill-path>/scripts/transition.mjs explore-to-plan",
  "/safe-plan uses transition.mjs for the explore-to-plan gate"
);
assertIncludes(
  safePlanDoc,
  "node <skill-path>/scripts/verify_gate.mjs plan-to-execute --planning-only",
  "/safe-plan validates plan quality with the planning-only verify_gate path"
);
assertIncludes(
  safePlanDoc,
  "the validator uses those files directly even without a `plans/` directory",
  "/safe-plan documents lightweight planning-only validation from task.md + implementation_plan.md"
);
assertIncludes(
  safePlanDoc,
  "do **not** run `transition.mjs plan-to-execute`",
  "/safe-plan explicitly stops before execution"
);
assertIncludes(
  safePlanDoc,
  "node <skill-path>/scripts/bootstrap.mjs close --informational",
  "/safe-plan documents the informational close path for planning-only sessions"
);
assertIncludes(
  safePlanDoc,
  "## Active Retros And Mistake Guards",
  "/safe-plan requires the retros and mistake-guard planning section"
);
assertIncludes(
  safePlanDoc,
  "Use matched retro ids, mistake ids, or KB anchors from `knowledge_resolver` instead of generic sources like \"prior learning\"",
  "/safe-plan requires concrete retro and mistake provenance in the planning audit"
);
assertIncludes(
  safePlanDoc,
  "## Exact Test Inventory",
  "/safe-plan requires the exact future test inventory section"
);
assertIncludes(
  safePlanDoc,
  "Name concrete future tests, files, or commands; generic \"add tests later\" wording is not enough",
  "/safe-plan rejects vague future-test planning"
);
assertIncludes(
  safePlanDoc,
  "## Plan Red-Team Review",
  "/safe-plan requires the plan-scoped red-team review section"
);
assertIncludes(
  safePlanDoc,
  "Align at least one row with a deterministic attack vector from `planner_findings.suggested_attack_vectors` or `knowledge_resolver.suggested_attack_vectors`",
  "/safe-plan requires the red-team review to align with deterministic attack vectors"
);
assertIncludes(
  safePlanDoc,
  "## Story And Traceability Audit",
  "/safe-plan requires the targeted story-audit section"
);
assertIncludes(
  safePlanDoc,
  "Use real story ids from the registry or linked criteria, not paraphrased story names",
  "/safe-plan requires story-audit rows to cite real story ids"
);
assertIncludes(
  safePlanDoc,
  "## Persona Challenges",
  "/safe-plan requires persona challenge coverage"
);
assertIncludes(
  safePlanDoc,
  "## Persona Expansion Opportunities",
  "/safe-plan requires persona expansion coverage"
);
assertIncludes(
  safePlanDoc,
  "When persona packs are present, cite their actual pack ids in the persona column",
  "/safe-plan grounds persona tables in detected persona packs when available"
);
assertIncludes(
  safePlanDoc,
  "node <skill-path>/scripts/planner_findings.mjs --dir <repo-root> --plan <plan-dir> --gate plan-to-execute --json",
  "/safe-plan documents the plan-scoped planner_findings audit input"
);
assertIncludes(
  safePlanDoc,
  "node <skill-path>/scripts/rule_engine.mjs verify-stories",
  "/safe-plan documents the targeted story verification command"
);
assertIncludes(
  safePlanDoc,
  "node <skill-path>/scripts/story_registry.mjs evidence --json",
  "/safe-plan documents the targeted story evidence command"
);
assertIncludes(
  safePlanDoc,
  "if the plan should remain active for immediate future implementation or an active plan already owns the handoff, leave it in `PLAN`",
  "/safe-plan documents the adaptive keep-in-PLAN closeout path"
);
assertIncludes(
  safePlanDoc,
  "| The prompt says plan first and then implement in the same session | Use `/safe-change` or `/safe-change-power`, not `/safe-plan` |",
  "/safe-plan clarifies that mixed plan-and-implement prompts should stay on an execution workflow"
);

assertIncludes(
  safeChangeDoc,
  "# /safe-change Workflow",
  "/safe-change workflow keeps its canonical heading"
);
assertIncludes(
  safeChangeDoc,
  "## Phase 2: RED-TEAM PARITY CHECK (Red Team Remediation)",
  "/safe-change workflow includes the red-team parity phase"
);
assertIncludes(
  safeChangeDoc,
  "node <skill-path>/scripts/validate-plan.mjs",
  "/safe-change workflow documents protocol validation before close"
);
assertIncludes(
  safeChangeDoc,
  "single-file static/UI deliverable",
  "/safe-change workflow routes static/UI one-file work to the lightweight branch"
);
assertIncludes(
  safeChangeDoc,
  "WordPress/CMS reports like `missing content`, `page looks empty`, or `custom post type missing` are diagnostic incidents",
  "/safe-change workflow routes WordPress missing-content incidents away from the lightweight branch"
);
assertIncludes(
  safeChangeDoc,
  "Are there any active migrations, recent plugin uninstalls, or major structural changes active on the site right now?",
  "/safe-change workflow teaches the exact CMS missing-content turbulence question"
);
assertIncludes(
  safeChangeDoc,
  "node <skill-path>/scripts/transition.mjs explore-to-plan",
  "/safe-change workflow uses transition.mjs for explore-to-plan"
);
assertIncludes(
  safeChangeDoc,
  "node <skill-path>/scripts/transition.mjs plan-to-execute",
  "/safe-change workflow uses transition.mjs for plan-to-execute"
);
assertIncludes(
  safeChangeDoc,
  "node <skill-path>/scripts/transition.mjs reflect-to-validate",
  "/safe-change workflow uses transition.mjs for reflect-to-validate"
);
assertIncludes(
  safeChangeDoc,
  "node <skill-path>/scripts/transition.mjs validate-to-close",
  "/safe-change workflow uses transition.mjs for validate-to-close"
);
assertIncludes(
  safeChangeDoc,
  "## Anti-Recurrence Guard",
  "/safe-change workflow documents the anti-recurrence guard for remediation-shaped work"
);
assertIncludes(
  safeChangeDoc,
  "node .agent/skills/iterative-planner/scripts/recipe_resolver.mjs --goal \"<task>\" --json",
  "/safe-change checks deterministic recipe routing before planner sizing"
);
assertIncludes(
  safeChangeDoc,
  "node .agent/skills/iterative-planner/scripts/planner_preflight.mjs --goal \"<task>\" --json",
  "/safe-change workflow runs planner_preflight.mjs before choosing a branch"
);
assertIncludes(
  safeChangePowerDoc,
  "If `/safe-change` routes the task to **Lightweight**, keep it lightweight.",
  "/safe-change-power preserves the lightweight branch for simple routed work"
);
assertIncludes(
  safeChangePowerDoc,
  "node .agent/skills/iterative-planner/scripts/recipe_resolver.mjs --goal \"<task>\" --json",
  "/safe-change-power checks deterministic recipe routing before planner sizing"
);
assertIncludes(
  safeChangePowerDoc,
  "node .agent/skills/iterative-planner/scripts/planner_preflight.mjs --goal \"<task>\" --json",
  "/safe-change-power reuses the shared planner preflight"
);
assertIncludes(
  safeChangePowerDoc,
  "node .agent/skills/iterative-planner/scripts/knowledge_resolver.mjs --goal \"<task>\" --json",
  "/safe-change-power compiles the shared discovery contract before execution"
);
assertIncludes(
  safeChangePowerDoc,
  "plan:anti-recurrence",
  "/safe-change-power documents the structured anti-recurrence waiver path"
);
assertIncludes(
  safeChangePowerDoc,
  "retro_recurrence_status",
  "/safe-change-power carries recurrence receipt status into ticket-shaped work"
);
assertIncludes(
  safeChangePowerDoc,
  "quant_persona_gate_status",
  "/safe-change-power carries quant persona gate status into ticket-shaped work"
);
assertIncludes(
  safeChangePowerDoc,
  "persona_signals",
  "/safe-change-power carries persona_signals into the execution context"
);
assertIncludes(
  safeChangePowerDoc,
  "knowledge_resolver.matches.trusted",
  "/safe-change-power reads trusted knowledge matches first"
);
assertIncludes(
  safeChangePowerDoc,
  "knowledge_resolver.matches.derived",
  "/safe-change-power documents advisory derived knowledge matches"
);
assertIncludes(
  safeChangePowerDoc,
  "knowledge_resolver.draft_candidate_prompt",
  "/safe-change-power documents the advisory draft-candidate prompt surface"
);
assertIncludes(
  safeChangePowerDoc,
  "Do not let `knowledge_resolver.matches.draft` or any LLM-produced draft candidate create blockers",
  "/safe-change-power forbids draft candidates from becoming planner truth"
);
assertIncludes(
  safeChangePowerDoc,
  "`advisor-review`",
  "/safe-change-power treats advisor-review as a first-class escalation"
);
assertIncludes(
  safeChangePowerDoc,
  "\"auto_launch\": true",
  "/safe-change-power documents the explicit advisor autorun JSON contract"
);
assertIncludes(
  safeChangePowerDoc,
  "Valid types: `red-team`, `regression`, `retro`, `user-story`, `advisor`",
  "/safe-change-power documents advisor audit logging"
);
assertIncludes(
  retroDoc,
  "## Anti-Recurrence Guard",
  "/retro workflow documents the explicit anti-recurrence guard section"
);
assertIncludes(
  claudeTemplateDoc,
  "/recipe-discovery",
  "CLAUDE.template.md advertises /recipe-discovery in the shipped root instruction surface"
);
assert(
  extractLevelTwoSection(claudeTemplateDoc, "## Transition Gate Quick Reference") === extractLevelTwoSection(rootClaudeDoc, "## Transition Gate Quick Reference"),
  "CLAUDE.template.md keeps the transition gate quick reference in sync with root CLAUDE.md"
);
assert(
  extractLevelTwoSection(claudeTemplateDoc, "## Available Workflows") === extractLevelTwoSection(rootClaudeDoc, "## Available Workflows"),
  "CLAUDE.template.md keeps the workflow catalog in sync with root CLAUDE.md"
);
assert(
  extractLevelTwoSection(claudeTemplateDoc, "## Key References") === extractLevelTwoSection(rootClaudeDoc, "## Key References"),
  "CLAUDE.template.md keeps the key references section in sync with root CLAUDE.md"
);
assertIncludes(
  retroDoc,
  "plan:anti-recurrence",
  "/retro workflow documents the structured anti-recurrence waiver subject"
);
assertIncludes(
  retroDoc,
  "retro_ledger.json",
  "/retro workflow documents the structured retro archive ledger"
);
assertIncludes(
  retroDoc,
  "promotion_decision",
  "/retro workflow documents explicit retro promotion decisions"
);
assertIncludes(
  consolidateAnnotationsDoc,
  "# /consolidate-annotations Workflow",
  "/consolidate-annotations keeps its canonical heading"
);
assertIncludes(
  recipeDiscoveryDoc,
  "# /recipe-discovery Workflow",
  "/recipe-discovery workflow keeps its canonical heading"
);
assertIncludes(
  recipeDiscoveryDoc,
  "recipe_discovery.mjs",
  "/recipe-discovery documents the discovery runtime"
);
assertIncludes(
  recipeDiscoveryDoc,
  "recipes/discovery_review.json",
  "/recipe-discovery documents the canonical review artifact"
);
assertIncludes(
  recipeDiscoveryDoc,
  "recent prompt",
  "/recipe-discovery documents recent prompts as a first-class proposal input"
);
assertIncludes(
  recipeDiscoveryDoc,
  "propose a new recipe",
  "/recipe-discovery explicitly frames prompt-driven recipe proposal"
);
assertIncludes(
  recipeDiscoveryDoc,
  "personas",
  "/recipe-discovery uses persona context as part of review enrichment"
);
assertIncludes(
  recipeDiscoveryDoc,
  "ontology",
  "/recipe-discovery uses ontology context as part of review enrichment"
);
assertIncludes(
  recipeDiscoveryDoc,
  "past prompts",
  "/recipe-discovery documents prior-request history as a discovery input"
);
assertIncludes(
  recipeDiscoveryDoc,
  "--from-discovery <candidate-id>",
  "/recipe-discovery hands approved candidates into recipe_bootstrap.mjs"
);
assertIncludes(
  recipeDiscoveryDoc,
  "node .agent/skills/iterative-planner/scripts/knowledge_resolver.mjs --goal \"<task>\" --json",
  "/recipe-discovery compiles the shared discovery context"
);
assertIncludes(
  recipeTidyDoc,
  "# /recipe-tidy Workflow",
  "/recipe-tidy workflow keeps its canonical heading"
);
assertIncludes(
  recipeTidyDoc,
  "recipes/entity_registry.json",
  "/recipe-tidy defines the entity registry source of truth"
);
assertIncludes(
  recipeTidyDoc,
  "recipes/capability_registry.json",
  "/recipe-tidy defines the capability registry source of truth"
);
assertIncludes(
  recipeTidyDoc,
  "recipes/<recipe-id>/recipe.json",
  "/recipe-tidy defines the per-recipe folder contract"
);
assertIncludes(
  recipeTidyDoc,
  "recipe_bootstrap.mjs",
  "/recipe-tidy documents the practical recipe bootstrap command"
);
assertIncludes(
  recipeTidyDoc,
  "recipe_runner.mjs",
  "/recipe-tidy documents the recipe runner execution surface"
);
assertIncludes(
  recipeTidyDoc,
  "new --parallel",
  "/recipe-tidy documents parallel-plan creation for same-repo work"
);
assertIncludes(
  recipeTidyDoc,
  "node .agent/skills/iterative-planner/scripts/knowledge_resolver.mjs --goal \"<task>\" --json",
  "/recipe-tidy reuses the shared discovery contract before normalizing recipes"
);
assertIncludes(
  recipeBootstrapDoc,
  "# /recipe-bootstrap Workflow",
  "/recipe-bootstrap workflow keeps its canonical heading"
);
assertIncludes(
  recipeBootstrapDoc,
  "recipes/discovery_review.json",
  "/recipe-bootstrap starts from the discovery review artifact"
);
assertIncludes(
  recipeBootstrapDoc,
  "recipe_bootstrap.mjs",
  "/recipe-bootstrap documents the deterministic bootstrap command"
);
assertIncludes(
  recipeBootstrapDoc,
  "--from-discovery <candidate-id>",
  "/recipe-bootstrap documents the approved discovery handoff"
);
assertIncludes(
  recipeBootstrapDoc,
  "recipe_runner.mjs",
  "/recipe-bootstrap documents the canonical runner surface"
);
assertIncludes(
  recipeBootstrapDoc,
  "--execute --live --json",
  "/recipe-bootstrap documents explicit live execution"
);
assertIncludes(
  recipeBootstrapDoc,
  "review.decision = \"approved\"",
  "/recipe-bootstrap requires approved discovery candidates before scaffolding"
);
assertIncludes(
  recipeBootstrapDoc,
  "node .agent/skills/iterative-planner/scripts/knowledge_resolver.mjs --goal \"<task>\" --json",
  "/recipe-bootstrap reuses the shared discovery contract before scaffolding"
);
assertIncludes(
  multiAgentDoc,
  "one repo-wide `.current_plan` pointer",
  "multi-agent operating model distinguishes the single pointer from parallel plan directories"
);
assertIncludes(
  multiAgentDoc,
  "one owner for each registry file",
  "multi-agent operating model requires explicit ownership for shared registries"
);

// US-035 /red-team-audit workflow
assertIncludes(
  redTeamAuditDoc,
  "# /red-team-audit Workflow",
  "/red-team-audit keeps its canonical heading"
);
assertIncludes(
  redTeamAuditDoc,
  "targeted adversarial EXPLORE/REFLECT path",
  "/red-team-audit documents adversarial planning as a posture inside the loop"
);
assertIncludes(
  redTeamAuditDoc,
  "anti_patterns.json",
  "/red-team-audit documents the machine-readable anti-pattern artifact"
);
assertIncludes(
  redTeamAuditDoc,
  "\"recommended_guard\": \"requires_red_team\"",
  "/red-team-audit documents the canonical anti-pattern artifact schema"
);
assertIncludes(
  redTeamAuditDoc,
  "## Domain Routing",
  "/red-team-audit preserves domain routing guidance"
);
assertIncludes(
  redTeamAuditDoc,
  "node <skill-path>/scripts/rule_engine.mjs check-invariants",
  "/red-team-audit requires invariant checks"
);
assertIncludes(
  redTeamAuditDoc,
  "### 0. Semantic Readiness",
  "/red-team-audit front-loads a semantic-readiness phase"
);
assertIncludes(
  redTeamAuditDoc,
  "node <skill-path>/scripts/planner_findings.mjs --json",
  "/red-team-audit uses planner_findings during semantic readiness"
);
assertIncludes(
  redTeamAuditDoc,
  "node <skill-path>/scripts/knowledge_resolver.mjs --json",
  "/red-team-audit uses knowledge_resolver persona signals during semantic readiness"
);
assertIncludes(
  redTeamAuditDoc,
  "knowledge_resolver.adversarial_profile",
  "/red-team-audit uses the shared adversarial profile to define project-specific attack meaning"
);
assertIncludes(
  redTeamAuditDoc,
  "planner_findings.suggested_attack_vectors",
  "/red-team-audit uses ontology-backed suggested attack vectors as the initial attack shortlist"
);
assertIncludes(
  redTeamAuditDoc,
  "missing-content incidents: ask exactly \"Are there any active migrations, recent plugin uninstalls, or major structural changes active on the site right now?\"",
  "/red-team-audit teaches the exact CMS missing-content turbulence question"
);
assertIncludes(
  redTeamAuditDoc,
  "treat missing/`0 bytes` content blocks as render crashes",
  "/red-team-audit teaches the CMS render-vs-query branch rule"
);
assertIncludes(
  redTeamAuditDoc,
  "/story-bootstrap",
  "/red-team-audit routes to story-bootstrap when story substrate is weak"
);
assertIncludes(
  redTeamAuditDoc,
  "/consolidate-annotations",
  "/red-team-audit routes to consolidate-annotations when annotation or config substrate is weak"
);
assertIncludes(
  redTeamAuditDoc,
  "Audit confidence: `strong`, `provisional`, or `blocked_by_substrate`",
  "/red-team-audit reports audit confidence explicitly"
);
assertIncludes(
  redTeamAuditDoc,
  "Do not treat tests or manual tracing as full audit proof while the semantic substrate is known to be weak.",
  "/red-team-audit caps confidence when substrate remains weak"
);
assertIncludes(
  redTeamAuditDoc,
  "node <skill-path>/scripts/checklist_runner.mjs --file .agent/skills/iterative-planner/checklists/domains/<domain>.yaml",
  "/red-team-audit documents the checklist runner with the correct --file ordering"
);
assertNotIncludes(
  redTeamAuditDoc,
  "node <skill-path>/scripts/checklist_runner.mjs domains/<domain>.yaml --file",
  "/red-team-audit no longer documents the invalid checklist_runner argument order"
);
assertIncludes(
  regressionAuditDoc,
  "node <skill-path>/scripts/checklist_runner.mjs --file .agent/skills/iterative-planner/checklists/domains/<domain>.yaml",
  "/regression-audit documents the checklist runner with the correct --file ordering"
);
assertNotIncludes(
  regressionAuditDoc,
  "node <skill-path>/scripts/checklist_runner.mjs domains/<domain>.yaml --file",
  "/regression-audit no longer documents the invalid checklist_runner argument order"
);

// /advisor workflow
assertIncludes(
  advisorDoc,
  "# /advisor Workflow",
  "/advisor workflow keeps its canonical heading"
);
assertIncludes(
  advisorDoc,
  "node .agent/skills/iterative-planner/scripts/recipe_resolver.mjs --json",
  "/advisor gathers deterministic recipe-routing output"
);
assertIncludes(
  advisorDoc,
  "node .agent/skills/iterative-planner/scripts/planner_preflight.mjs --json",
  "/advisor gathers the shared planner preflight output"
);
assertIncludes(
  advisorDoc,
  "node .agent/skills/iterative-planner/scripts/planner_findings.mjs --json",
  "/advisor gathers the deterministic planner findings output"
);
assertIncludes(
  advisorDoc,
  "node .agent/skills/iterative-planner/scripts/planner_hygiene.mjs scan --json",
  "/advisor gathers the planner hygiene scan output"
);
assertIncludes(
  advisorDoc,
  "missing semantic substrate",
  "/advisor tells operators to report missing semantic substrate from planner_findings"
);
assertIncludes(
  advisorDoc,
  "`config_fact_gap`",
  "/advisor documents missing mutually-exclusive config facts as a first-class warning pattern"
);
assertIncludes(
  advisorDoc,
  "node .agent/skills/iterative-planner/scripts/rule_engine.mjs suggest-next --json",
  "/advisor gathers proactive suggestion-engine output"
);
assertIncludes(
  storyBootstrapDoc,
  "do `postconditions` describe the expected end state?",
  "/story-bootstrap teaches operators to add postconditions for stateful/user-visible stories"
);
assertIncludes(
  storyBootstrapDoc,
  "should `conflicts` name that relationship explicitly?",
  "/story-bootstrap teaches operators to declare conflicting stories explicitly"
);
assertIncludes(
  advisorDoc,
  "node .agent/skills/iterative-planner/scripts/intent_contract_bootstrap.mjs --dry-run --json",
  "/advisor gathers draft intent-contract output"
);
assertIncludes(
  advisorDoc,
  "current `authority_profile`",
  "/advisor reports the current authority profile"
);
assertIncludes(
  advisorDoc,
  "current `audit_posture`",
  "/advisor reports the current audit posture"
);
assertIncludes(
  advisorDoc,
  "`symmetry_hunts`",
  "/advisor reports structured symmetry hunt candidates"
);
assertIncludes(
  advisorDoc,
  "matches.trusted",
  "/advisor documents trusted knowledge matches as the first retrieval tier"
);
assertIncludes(
  advisorDoc,
  "matches.derived",
  "/advisor documents derived knowledge matches as advisory context"
);
assertIncludes(
  advisorDoc,
  "draft_candidate_prompt",
  "/advisor documents the advisory draft gap-check brief"
);
assertIncludes(
  advisorDoc,
  "Do not let `matches.draft`, `draft_candidate_prompt`, or any later LLM suggestion create blockers",
  "/advisor forbids draft candidates from becoming planner truth"
);
assertIncludes(
  advisorDoc,
  "`planner_hygiene.mjs` is an advisor input and optional expert triage surface",
  "/advisor positions planner_hygiene as optional expert triage instead of ritual"
);
assertIncludes(
  advisorDoc,
  "node .agent/skills/iterative-planner/scripts/rule_engine.mjs verify-stories",
  "/advisor documents conditional verify-stories escalation"
);
assertIncludes(
  advisorDoc,
  "node .agent/skills/iterative-planner/scripts/rule_engine.mjs find-conflicts",
  "/advisor documents conditional find-conflicts escalation"
);
assertIncludes(
  advisorDoc,
  "### 3. Intent Consolidation",
  "/advisor documents the intent consolidation section"
);
assertIncludes(
  advisorDoc,
  "### 5. Proactive Improvements",
  "/advisor documents the proactive improvements section after intent consolidation"
);
assertIncludes(
  advisorDoc,
  "/steward",
  "/advisor can escalate clustered project drift into /steward"
);
assertIncludes(
  advisorDoc,
  "[WORKFLOW_AUTORUN:/advisor]",
  "/advisor documents the explicit advisor autorun marker"
);
assertIncludes(
  advisorDoc,
  "\"auto_launch\": true",
  "/advisor documents the explicit advisor autorun JSON contract"
);
assertIncludes(
  skillDoc,
  "Loop First, Determinism Second, Generalize Last.",
  "SKILL.md documents the planner doctrine"
);
assertIncludes(
  skillDoc,
  "### Phase Authority Model",
  "SKILL.md documents the phase authority model"
);
assertIncludes(
  skillDoc,
  "do not add continuous EXECUTE-time second-guessing",
  "SKILL.md keeps EXECUTE free from continuous persona/ontology supervision"
);
assertIncludes(
  skillDoc,
  "`symmetry_hunts`",
  "SKILL.md documents knowledge_resolver symmetry hunts"
);
assertIncludes(
  skillDoc,
  "[WORKFLOW_AUTORUN:/advisor]",
  "SKILL.md documents the explicit advisor autorun marker"
);
assertIncludes(
  rootClaudeDoc,
  "## Advisor Autorun",
  "root CLAUDE.md documents the advisor autorun section"
);
assertIncludes(
  claudeTemplateDoc,
  "## Advisor Autorun",
  "CLAUDE.template.md documents the advisor autorun section"
);
assert(
  extractLevelTwoSection(claudeTemplateDoc, "## Advisor Autorun") === extractLevelTwoSection(rootClaudeDoc, "## Advisor Autorun"),
  "CLAUDE.template.md keeps the advisor autorun section in sync with root CLAUDE.md"
);
assertIncludes(
  rootClaudeDoc,
  "## Domain Persona Autorun",
  "root CLAUDE.md documents the domain persona autorun section"
);
assertIncludes(
  claudeTemplateDoc,
  "## Domain Persona Autorun",
  "CLAUDE.template.md documents the domain persona autorun section"
);
assert(
  extractLevelTwoSection(claudeTemplateDoc, "## Domain Persona Autorun") === extractLevelTwoSection(rootClaudeDoc, "## Domain Persona Autorun"),
  "CLAUDE.template.md keeps the domain persona autorun section in sync with root CLAUDE.md"
);
assert(
  extractLevelTwoSection(rootGeminiDoc, "## Domain Persona Autorun") === extractLevelTwoSection(rootClaudeDoc, "## Domain Persona Autorun"),
  "GEMINI.md keeps the domain persona autorun section in sync with root CLAUDE.md"
);
assert(
  extractLevelTwoSection(rootAgentsDoc, "## Domain Persona Autorun") === extractLevelTwoSection(rootClaudeDoc, "## Domain Persona Autorun"),
  "AGENTS.md keeps the domain persona autorun section in sync with root CLAUDE.md"
);
for (const [doc, label] of [
  [rootClaudeDoc, "root CLAUDE.md"],
  [claudeTemplateDoc, "CLAUDE.template.md"],
  [safeChangePowerDoc, "/safe-change-power"],
]) {
  assertIncludes(doc, "persona_adapt.mjs scan . --json", `${label} tells agents to run persona adaptation scan`);
  assertIncludes(doc, "quant", `${label} exposes quant persona routing`);
  assertIncludes(doc, "hyperparameter", `${label} exposes hyperparameter/optimizer routing`);
  assertIncludes(doc, "tokenomics", `${label} exposes tokenomics persona routing`);
  assertIncludes(doc, "ux_ui", `${label} exposes UX/UI persona routing`);
  assertIncludes(doc, "wiring_auditor", `${label} exposes wiring/integration persona routing`);
  assertIncludes(doc, "config_integrity", `${label} exposes config-integrity persona routing`);
  assertIncludes(doc, "assumptions_challenger", `${label} exposes assumptions-challenger persona routing`);
  assertIncludes(doc, "traceability", `${label} exposes traceability persona routing`);
}
assertIncludes(
  readmeDoc,
  "Loop First, Determinism Second, Generalize Last.",
  "README keeps the doctrine visible in the public planner surface"
);
assertIncludes(
  readmeDoc,
  "Adversarial posture, not a fifth phase",
  "README documents adversarial planning as posture rather than a new phase"
);
assertIncludes(
  readmeDoc,
  "Treat it as optional expert triage and an `/advisor` input",
  "README positions planner_hygiene as optional expert triage"
);
assertIncludes(
  readmeDoc,
  "authority_profile",
  "README documents authority_profile in the public routing surface"
);
assertIncludes(
  readmeDoc,
  "symmetry_hunts",
  "README documents symmetry_hunts in the public routing surface"
);
assertIncludes(
  stewardDoc,
  "/steward",
  "/steward remains available as the consolidation escalation surface"
);
assertIncludes(
  readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/references/planner-manifesto.md"), "utf-8"),
  "Loop First, Determinism Second, Generalize Last.",
  "planner-manifesto mirror documents the doctrine"
);
assertIncludes(
  readFileSync(join(plannerRoot, ".agent/rules.md"), "utf-8"),
  "EXECUTE consumes obligations and records evidence",
  "rules.md documents the execute-phase anti-ritual guardrail"
);
assertIncludes(
  readFileSync(join(plannerRoot, ".agent/workflows/full-review-and-fix.md"), "utf-8"),
  "reports/red_team_audit/anti_patterns.json",
  "/full-review-and-fix consumes the structured anti-pattern artifact"
);
assertIncludes(
  readFileSync(join(plannerRoot, ".agent/workflows/full-review-and-fix.md"), "utf-8"),
  "story_registry.mjs evidence --json",
  "/full-review-and-fix requires the stronger story evidence surface"
);
assertIncludes(
  readFileSync(join(plannerRoot, ".agent/workflows/full-review-and-fix.md"), "utf-8"),
  "Do not invent a separate anti-pattern ledger",
  "/full-review-and-fix reuses the existing anti-pattern surface instead of parallel review ritual"
);
assertIncludes(
  userStoryAuditDoc,
  "story_registry.mjs evidence --json",
  "/red-team-user-story-audit requires the stronger story evidence surface"
);
assertIncludes(
  userStoryAuditDoc,
  "### 0. Semantic Readiness",
  "/red-team-user-story-audit front-loads semantic readiness"
);
assertIncludes(
  userStoryAuditDoc,
  "/story-bootstrap",
  "/red-team-user-story-audit routes to story-bootstrap when story substrate is weak"
);
assertIncludes(
  userStoryAuditDoc,
  "/consolidate-annotations",
  "/red-team-user-story-audit routes to consolidate-annotations when annotation substrate is weak"
);
assertIncludes(
  userStoryAuditDoc,
  "### 2.5. Early Formal Verification",
  "/red-team-user-story-audit adds an early formal verification pass"
);
assertIncludes(
  userStoryAuditDoc,
  "### 7.6. Final Formal Verification",
  "/red-team-user-story-audit adds a final formal verification pass"
);
assertIncludes(
  userStoryAuditDoc,
  "## Substrate Findings",
  "/red-team-user-story-audit distinguishes substrate findings from coverage findings"
);
assertIncludes(
  userStoryAuditDoc,
  "Audit confidence: `strong`, `provisional`, or `blocked_by_substrate`",
  "/red-team-user-story-audit reports audit confidence explicitly"
);
assertIncludes(
  userStoryAuditDoc,
  "If the registry, annotations, or ontology for a story are materially broken, cap the story at `PARTIALLY_COVERED` or `PROVISIONAL` until the substrate is repaired.",
  "/red-team-user-story-audit caps story confidence when semantic substrate is broken"
);
assertIncludes(
  userStoryAuditDoc,
  "Tests and manual traces do not erase ontology drift.",
  "/red-team-user-story-audit rejects manual proof as a substitute for semantic truth"
);
assertNotIncludes(
  userStoryAuditDoc,
  "Formal Verification (Optional",
  "/red-team-user-story-audit no longer treats formal verification as optional"
);
assertIncludes(
  stewardDoc,
  "# /steward Workflow",
  "/steward workflow keeps its canonical heading"
);
assertIncludes(
  stewardDoc,
  "reports/stewardship/opportunity_queue.json",
  "/steward defines the machine-readable stewardship ledger"
);
assertIncludes(
  stewardDoc,
  "reports/stewardship/consolidation_report.md",
  "/steward defines the human-readable stewardship report"
);
assertIncludes(
  stewardDoc,
  "reports/stewardship/semantic_map.json",
  "/steward defines the machine-readable semantic map output when domain entities are in scope"
);
assertIncludes(
  stewardDoc,
  "node .agent/skills/iterative-planner/scripts/semantic_map.mjs generate --focus \"<scope>\" --out reports/stewardship/semantic_map.json",
  "/steward documents the semantic_map generator command"
);
assertIncludes(
  stewardDoc,
  "node .agent/skills/iterative-planner/scripts/semantic_map.mjs check reports/stewardship/semantic_map.json --json",
  "/steward documents semantic_map validation"
);
assertIncludes(
  stewardDoc,
  "## Phase 3: Search Thoroughness Gate",
  "/steward makes search thoroughness a first-class workflow phase"
);
assertIncludes(
  stewardDoc,
  "Do not stop after the first plausible hit.",
  "/steward explicitly rejects shallow first-hit searching"
);
assertIncludes(
  stewardDoc,
  "The ontology is the semantic truth layer for thoroughness.",
  "/steward ties review thoroughness back to ontology-backed evidence"
);
assertIncludes(
  stewardDoc,
  "node .agent/skills/iterative-planner/scripts/knowledge_resolver.mjs --goal \"<task>\" --json",
  "/steward seeds the census from the shared discovery contract"
);
assertIncludes(
  stewardDoc,
  "Use `knowledge_resolver` as the deterministic seed for the census:",
  "/steward documents how knowledge_resolver feeds the stewardship census"
);
assertIncludes(
  stewardDoc,
  "persona_signals",
  "/steward treats persona_signals as part of the deterministic census seed"
);
assertIncludes(
  stewardDoc,
  "node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-workflow /steward launched /advisor",
  "/steward documents how to log advisor-routed launch events"
);
assertIncludes(
  stewardDoc,
  "node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-workflow /steward completed /advisor",
  "/steward documents how to log advisor-routed completion events"
);
assertIncludes(
  smeImprovementDoc,
  "# /sme-improvement Workflow",
  "/sme-improvement workflow keeps its canonical heading"
);
assertIncludes(
  smeImprovementDoc,
  "node .agent/skills/iterative-planner/scripts/knowledge_resolver.mjs --goal \"<task>\" --json",
  "/sme-improvement uses the shared discovery contract"
);
assertIncludes(
  smeImprovementDoc,
  "config/planner_manifesto.json",
  "/sme-improvement anchors planner-core work to the machine-readable planner manifesto"
);
assertIncludes(
  smeImprovementDoc,
  "references/planner-manifesto.md",
  "/sme-improvement anchors planner-core work to the human-readable manifesto mirror"
);
assertIncludes(
  smeImprovementDoc,
  "knowledge_resolver.persona_signals",
  "/sme-improvement treats persona_signals as the committee summary"
);
assertIncludes(
  smeImprovementDoc,
  "node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-workflow /sme-improvement launched /advisor",
  "/sme-improvement documents how to log advisor-routed launch events"
);
assertIncludes(
  smeImprovementDoc,
  "node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-workflow /sme-improvement completed /advisor",
  "/sme-improvement documents how to log advisor-routed completion events"
);
assertIncludes(
  userStoryAuditDoc,
  "Sibling-path search",
  "/red-team-user-story-audit expands search beyond the first plausible path"
);
assertIncludes(
  userStoryAuditDoc,
  "Do not mark a story `FULLY_COVERED` or `NOT_IMPLEMENTED` from a single-surface search result.",
  "/red-team-user-story-audit forbids single-surface coverage claims"
);
assertIncludes(
  skillDoc,
  "node <sp>/scripts/planner_preflight.mjs --goal \"<goal>\" --json",
  "SKILL.md documents the deterministic planner preflight command"
);
assertIncludes(
  skillDoc,
  "The returned contract is the shared routing surface used by `/safe-plan`, `/safe-change`, `/safe-change-power`, and `/advisor`",
  "SKILL.md makes the planner preflight the shared routing contract"
);
assertIncludes(
  skillDoc,
  "Criterion | Story linkage | Check | Pass means",
  "SKILL.md documents the explicit criterion/story traceability table for verification strategies"
);
assertIncludes(
  skillDoc,
  "Are there any active migrations, recent plugin uninstalls, or major structural changes active on the site right now?",
  "SKILL.md teaches the exact CMS missing-content turbulence question"
);
assertIncludes(
  skillDoc,
  "the render-vs-query branch (`0 bytes`/missing block = render crash; HTML shell with empty collections = backend/query)",
  "SKILL.md teaches the CMS render-vs-query branch rule"
);
assertIncludes(
  skillDoc,
  "Keep gate-owned artifacts live",
  "SKILL.md tells operators to keep gate-owned artifacts live during EXECUTE"
);
assertIncludes(
  skillDoc,
  "Default to a dedicated `## Proof of Work` section",
  "SKILL.md teaches the dedicated Proof of Work section during VALIDATE"
);
assertIncludes(
  skillDoc,
  "every criterion must map to at least one story ID",
  "SKILL.md makes explicit criterion/story linkage mandatory when a story registry exists"
);
assertIncludes(
  skillDoc,
  "Annotations help coverage and ontology facts, but they do not create `code_refs`, `test_refs`, or `validation_refs`.",
  "SKILL.md distinguishes annotations from story-registry evidence refs"
);
assertIncludes(
  skillDoc,
  "node <skill-path>/scripts/story_registry.mjs evidence <story-id>",
  "SKILL.md documents the targeted story-registry evidence diagnostic"
);
assertIncludes(
  skillDoc,
  "Single-file static/UI/page-clone deliverables",
  "SKILL.md routes page-clone style UI work to the lightweight flow"
);
assertIncludes(
  skillDoc,
  "History-poisoned or abandoned plan where the remaining work is now simple",
  "SKILL.md lets recovered simple work switch to the lightweight flow"
);
assertIncludes(
  skillDoc,
  "Pure static UI/page deliverables",
  "SKILL.md documents the static UI manual-evidence close path"
);
assertIncludes(
  skillDoc,
  "Learned Verification Obligations (registry-backed)",
  "SKILL.md documents the registry-backed learned-obligation contract"
);
assertIncludes(
  skillDoc,
  "config/mistake_registry.json",
  "SKILL.md documents the mistake-registry source for learned verification"
);
assertIncludes(
  skillDoc,
  "`plans/INDEX.md`",
  "SKILL.md documents plans/INDEX.md as a planner artifact"
);
assertIncludes(
  skillDoc,
  "start with `plans/INDEX.md`, then use `plans/FINDINGS.md` and `plans/DECISIONS.md` for deep dives",
  "SKILL.md makes the compact plan index the default cross-plan entrypoint"
);
assertIncludes(
  ruleEngineGuideDoc,
  "Evidence refs from `story_registry.json`",
  "rule-engine guide explains that story_registry.json owns evidence refs"
);
assertIncludes(
  ruleEngineGuideDoc,
  "`validation_ref/2`",
  "rule-engine guide documents validation_ref facts in the story registry layer"
);
assertIncludes(
  ruleEngineGuideDoc,
  "proof_telemetry_mode/1",
  "rule-engine guide documents telemetry-backed proof facts"
);
assertIncludes(
  fileFormatsDoc,
  "Story linkage in `plan.md` tells the ontology which story proves a criterion.",
  "file-formats reference explains the plan.md linkage role in the traceability model"
);
assertIncludes(
  fileFormatsDoc,
  "## plans/<plan>/telemetry/events.jsonl",
  "file-formats reference documents the raw proof telemetry event log"
);
assertIncludes(
  fileFormatsDoc,
  "## plans/<plan>/telemetry/summary.json",
  "file-formats reference documents the proof telemetry summary artifact"
);
assertIncludes(
  fileFormatsDoc,
  "telemetry absence is advisory only in v1",
  "file-formats reference documents advisory-only behavior when telemetry is absent"
);
assertIncludes(
  errorRecoveryDoc,
  "finish the actual implementation via the lightweight flow",
  "ERROR-RECOVERY.md routes simple work out of a poisoned heavy plan"
);
assertIncludes(
  fileFormatsDoc,
  "static UI deliverables whose intent contract uses `manual_observation`",
  "file-formats reference documents the static UI manual-evidence close signal"
);
assertIncludes(
  fileFormatsDoc,
  "## Learned Obligations",
  "file-formats reference documents the markdown fallback section for learned obligations"
);
assertIncludes(
  fileFormatsDoc,
  "registry-defined `subject_id` and `verification_mode`",
  "file-formats reference documents the ledger-first learned-obligation proof shape"
);
assertIncludes(
  fileFormatsDoc,
  "close_signals.mistake_registry",
  "file-formats reference documents the advisory mistake-registry close signal"
);
assertIncludes(
  fileFormatsDoc,
  "## Active Mistake Response",
  "file-formats reference documents the conditional plan surface for active mistake guards"
);
assertIncludes(
  fileFormatsDoc,
  "site_turbulence`, `raw_html_dom_probe`, and `entity_preservation`",
  "file-formats reference documents the CMS missing-content guard tokens"
);
assertIncludes(
  fileFormatsDoc,
  "plan:cms-missing-content-turbulence",
  "file-formats reference documents the CMS missing-content learned-obligation subjects"
);
assertIncludes(
  fileFormatsDoc,
  "## Active Mistake Evidence",
  "file-formats reference documents the conditional verification surface for active mistake proof"
);
assertIncludes(
  wordpressChecklistDoc,
  "Are there any active migrations, recent plugin uninstalls, or major structural changes active on the site right now?",
  "WordPress checklist documents the exact CMS missing-content turbulence question"
);
assertIncludes(
  wordpressChecklistDoc,
  "0 bytes",
  "WordPress checklist documents the CMS render-vs-query branch cue"
);
assertIncludes(
  fileFormatsDoc,
  "## plans/knowledge/retros/retro_ledger.json",
  "file-formats reference documents the structured retro archive ledger"
);
assertIncludes(
  fileFormatsDoc,
  "## plans/knowledge/retros/cases/R-*.md",
  "file-formats reference documents retro case files"
);
assertIncludes(
  migrateAllDoc,
  "node .agent/skills/iterative-planner/scripts/migrate.mjs verify-fleet --json",
  "/migrate-all documents fleet verification with the new second-pass contract"
);
assertIncludes(
  migrateAllDoc,
  "second_pass_verification",
  "/migrate-all treats second_pass_verification as a first-class migration surface"
);
assertIncludes(
  migrateAllDoc,
  "host_project_surfaces.annotation_coverage",
  "/migrate-all documents annotation coverage as a host-project verify-fleet surface"
);
assertIncludes(
  migrateAllDoc,
  "host_project_surfaces.telemetry_capture",
  "/migrate-all documents telemetry readiness as a host-project verify-fleet surface"
);
assertIncludes(
  migrationDoc,
  "host_project_surfaces.annotation_coverage",
  "MIGRATION.md documents annotation coverage in verify-fleet output"
);
assertIncludes(
  migrateAllDoc,
  "host_project_surfaces.workflow_intelligence",
  "/migrate-all documents workflow uptake intelligence as a host-project verify-fleet surface"
);
assertIncludes(
  migrateAllDoc,
  "sh .agent/skills/iterative-planner/scripts/hooks/run-node.sh .agent/skills/iterative-planner/scripts/hooks/install.mjs --trace-hook",
  "/migrate-all documents the trace-hook repair command for missing telemetry readiness"
);
assertIncludes(
  migrationDoc,
  "Host-project-owned discovery, recipe, and story surfaces are preserved during migration.",
  "MIGRATION.md preserves host-project-owned discovery and traceability surfaces during fleet upgrades"
);
assertIncludes(
  migrationDoc,
  "node .agent/skills/iterative-planner/scripts/migrate.mjs verify-fleet --json",
  "MIGRATION.md documents verify-fleet for post-upgrade fleet classification"
);
assertIncludes(
  migrationDoc,
  "node .agent/skills/iterative-planner/scripts/migrate.mjs promote-knowledge . --json",
  "MIGRATION.md documents the preview form of promote-knowledge"
);
assertIncludes(
  migrationDoc,
  "planner.mistake_overrides.json",
  "MIGRATION.md documents host-owned mistake overlay promotion"
);
assertIncludes(
  migrationDoc,
  "plans/knowledge/retros/retro_ledger.json",
  "MIGRATION.md documents preserved host-owned retro archive surfaces"
);
assertIncludes(
  migrationDoc,
  "promotion_decision",
  "MIGRATION.md documents retro-ledger promotion precedence for promote-knowledge"
);
assertIncludes(
  migrationDoc,
  "scripts/lib/proof_telemetry.mjs",
  "MIGRATION.md documents proof telemetry as a migrated planner-core library"
);
assertIncludes(
  migrationDoc,
  "host_project_surfaces.telemetry_capture",
  "MIGRATION.md documents telemetry readiness in verify-fleet output"
);
assertIncludes(
  migrationDoc,
  "host_project_surfaces.workflow_intelligence",
  "MIGRATION.md documents workflow uptake intelligence in verify-fleet output"
);
assertIncludes(
  migrationDoc,
  "sh .agent/skills/iterative-planner/scripts/hooks/run-node.sh .agent/skills/iterative-planner/scripts/hooks/install.mjs --trace-hook",
  "MIGRATION.md documents the telemetry hook repair command"
);
assertIncludes(
  migrateAllDoc,
  "node .agent/skills/iterative-planner/scripts/migrate.mjs promote-knowledge \"<path>\" --json",
  "/migrate-all documents the knowledge-promotion preview wave"
);
assertIncludes(
  advisorDoc,
  "proof-telemetry-derived gaps",
  "/advisor tells operators to surface proof-telemetry-derived gaps from planner_findings"
);
assertIncludes(
  advisorDoc,
  "node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-recommendation /steward /advisor",
  "/advisor documents how to record a routed stewardship recommendation"
);
assertIncludes(
  advisorDoc,
  "node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-recommendation /sme-improvement /advisor",
  "/advisor documents how to record a routed SME-improvement recommendation"
);
assertIncludes(
  advisorDoc,
  "node .agent/skills/iterative-planner/scripts/escalation_check.mjs log-recommendation /ticket-traceability-repair /advisor",
  "/advisor documents how to record a routed ticket-traceability repair recommendation"
);
assertIncludes(
  advisorDoc,
  "records both the advisor audit and an explicit `/advisor` completion event",
  "/advisor documents that self-log now records explicit advisor completion history"
);
assertIncludes(
  fileFormatsDoc,
  "## planner.mistake_overrides.json",
  "file-formats reference documents host-owned mistake overlay files"
);
assertIncludes(
  fileFormatsDoc,
  "## planner.learned_obligations.json",
  "file-formats reference documents host-owned learned-obligation overlay files"
);

// Housekeeping workflow
assertIncludes(
  housekeepingDoc,
  "# /housekeeping Workflow",
  "/housekeeping workflow keeps its canonical heading"
);
assertIncludes(
  housekeepingDoc,
  "Stale repo-owned references are corrected.",
  "/housekeeping workflow defines cleanup success criteria"
);
assertIncludes(
  readmeDoc,
  "/housekeeping",
  "README advertises the housekeeping workflow in the public workflow surface"
);
assertIncludes(
  readmeDoc,
  "/steward",
  "README advertises the stewardship workflow in the public workflow surface"
);
assertIncludes(
  readmeDoc,
  "/recipe-bootstrap",
  "README advertises the recipe bootstrap workflow in the public workflow surface"
);
assertIncludes(
  readmeDoc,
  "recipe_runner.mjs",
  "README advertises the recipe runner script in the public planner surface"
);

// US-039 Red-team remediation skill
assertIncludes(
  remediationDoc,
  "# Red Team Remediation",
  "red-team remediation skill keeps its canonical heading"
);
assertIncludes(
  remediationDoc,
  "GENERALIZE",
  "red-team remediation skill documents the GENERALIZE phase"
);
assertIncludes(
  remediationDoc,
  "The iterative planner's SKILL.md rules (mandatory re-reads, autonomy leash, complexity control, code hygiene) all apply within the FIX phase.",
  "red-team remediation skill preserves iterative-planner integration rules"
);
assertIncludes(
  remediationDoc,
  "### Constraint 0: Plan Traceability Gate",
  "red-team remediation skill adds the plan traceability gate"
);
assertIncludes(
  remediationDoc,
  "Do **not** rely on `Files To Modify` overlap heuristics as your primary remediation traceability story.",
  "red-team remediation skill warns against heuristic-only traceability"
);
assertIncludes(
  remediationDoc,
  "### Constraint 2b: Keep planner artifacts gate-ready during the fix loop",
  "red-team remediation skill adds the gate-ready artifact constraint"
);
assertIncludes(
  remediationDoc,
  "REGRESSION-GATE should validate the accumulated evidence, not backfill it from memory.",
  "red-team remediation skill warns against end-loading closeout evidence"
);
assertIncludes(
  remediationDoc,
  "Planner-Core Contract Packet",
  "red-team remediation documents the planner-core debug packet for parser and gate drift"
);
assertIncludes(
  remediationDoc,
  "Do not patch planner prose first just because the failure is rendered through markdown.",
  "red-team remediation keeps markdown-looking planner failures on the deterministic debug path"
);
assertIncludes(
  rulesDoc,
  "## 11. Deterministic Planner-Core Debug Packet (Retro 2026-04-12)",
  "rules.md records the deterministic planner-core debug packet as a top-level rule"
);
assertIncludes(
  rulesDoc,
  "Classify the mismatch before patching: `missing_artifact`, `stale_integrity`, `parser_normalization_bug`, or `js_prolog_divergence`.",
  "rules.md teaches the planner-core mismatch taxonomy before edits"
);

// US-042 Lightweight invocation
assertIncludes(
  skillDoc,
  "### Lightweight Invocation (via /safe-change)",
  "SKILL.md documents lightweight invocation"
);
assertIncludes(
  skillDoc,
  "Skip bootstrap",
  "lightweight invocation explicitly skips bootstrap"
);
assertIncludes(
  skillDoc,
  "task.md",
  "lightweight invocation retains the task.md artifact"
);
assertIncludes(
  skillDoc,
  "implementation_plan.md",
  "lightweight invocation retains the implementation_plan.md artifact"
);
assertIncludes(
  skillDoc,
  "walkthrough.md",
  "lightweight invocation retains the walkthrough.md artifact"
);

// Approval-mode contract
assertIncludes(
  skillDoc,
  "In default `auto` mode, `transition.mjs explore-to-plan` writes it directly.",
  "SKILL.md documents auto approval as the default full-workflow path"
);
assertIncludes(
  skillDoc,
  "do **not** tell the user to start the approval daemon unless the project has explicitly switched to `interactive` mode",
  "SKILL.md prevents daemon-first guidance for default full workflows"
);
assertIncludes(
  skillDoc,
  "In `auto` mode (default), no extra PLAN-phase user action is needed",
  "SKILL.md keeps PLAN approval guidance mode-aware"
);
assertIncludes(
  quickstartDoc,
  "Auto mode is the default for full workflows.",
  "QUICKSTART documents auto approval as the default"
);
assertIncludes(
  readmeDoc,
  "Some cleanup, audit, or planner-maintenance tasks legitimately finish during EXPLORE.",
  "README explains the EXPLORE-only informational close path"
);
assertIncludes(
  quickstartDoc,
  "### EXPLORE-Only Closeouts",
  "QUICKSTART gives EXPLORE-only closeouts a dedicated section"
);
assertIncludes(
  quickstartDoc,
  "Preserved `CLOSE` plan directories are normal history, not crash residue.",
  "QUICKSTART explains that preserved closed plans are expected history"
);
assertIncludes(
  errorRecoveryDoc,
  "`auto` mode: the prior `explore-to-plan` transition needs to be re-run",
  "ERROR-RECOVERY distinguishes auto-mode approval recovery from daemon issues"
);
assertIncludes(
  errorRecoveryDoc,
  "### Plan is actually complete in EXPLORE or PLAN",
  "ERROR-RECOVERY distinguishes informational completion from stuck-plan recovery"
);
assertIncludes(
  edgeCasesDoc,
  "Cleanup/admin/audit task finishes during EXPLORE",
  "EDGE-CASES documents informational close eligibility from EXPLORE"
);
assertIncludes(
  skillDoc,
  "`bootstrap.mjs recover-poison`",
  "SKILL.md documents the first-class poisoned-plan recovery command"
);
assertIncludes(
  errorRecoveryDoc,
  "bootstrap.mjs recover-poison",
  "ERROR-RECOVERY teaches recover-poison as the supported AV-19 recovery path"
);
assertIncludes(
  migrationDoc,
  "On v3.8.5+, the approval daemon is optional for ordinary full workflows because `approval.mode`",
  "MIGRATION documents that the approval daemon is optional under the default mode"
);
assertIncludes(
  skillDoc,
  "persona_activation_authority",
  "SKILL.md documents the persona activation authority preflight payload"
);
assertIncludes(
  skillDoc,
  "suppressed_domain_profiles",
  "SKILL.md documents suppressed persona profiles as audit-visible but non-authoritative"
);
assertIncludes(
  skillDoc,
  "audit.config.json.force_packs",
  "SKILL.md documents force_packs as the explicit override for persona authority suppression"
);
assertIncludes(
  migrationDoc,
  "Persona Activation Authority",
  "MIGRATION documents the persona activation authority release row"
);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
