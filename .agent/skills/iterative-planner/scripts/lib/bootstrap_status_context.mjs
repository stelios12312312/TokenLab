import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

export function createBootstrapStatusContext({
  cwd,
  plansDir,
  skillPath,
  hashRuleFiles,
  loadPlannerPolicy,
  DEFAULT_PLANNER_POLICY,
  relativeToProject,
  inferPersonaAdaptation,
  isProblematicPersonaStatus,
  compactList,
  readStateJson,
  computeVerificationObligationSynthesis,
  formatPersonaArtifactIssue,
  renderPersonaTriggeredRecommendations,
  collectProvisionalPersonaTriggeredRecommendations,
  loadPlanWorkOrder,
  extractSuccessCriteria,
  analyzeVerificationMatrix,
  buildVerificationEvidenceGuidance,
  renderEvidenceGuidance,
  measurePlanScaffolding,
  proportionalityVerdict,
  extractGoalFromPlanContent,
  extractFilesToModify,
  deriveTaskFocusContract,
  buildOntologyPackGuardContract,
  renderOntologyPackGuardSummary,
  resolvePersonaAuthorityPlanContext,
  summarizePersonaAuthority,
  decidePersonaPackActivation,
  renderPersonaAuthoritySummary,
  renderPersonaShapeSuppressionConflicts,
  resolvePlannerPolicyShape,
}) {
  function formatArtifactAge(timestamp) {
    const then = Date.parse(timestamp || "");
    if (!Number.isFinite(then)) return "unknown age";
    const diffMs = Math.max(0, Date.now() - then);
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function findLatestCheckInvariantsArtifact(projectRoot = cwd) {
    const rootPlansDir = join(projectRoot, "plans");
    if (!existsSync(rootPlansDir)) return null;
    const candidates = [];
    for (const entry of readdirSync(rootPlansDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("plan_")) continue;
      const prologDir = join(rootPlansDir, entry.name, "artifacts", "prolog");
      if (!existsSync(prologDir)) continue;
      for (const artifact of readdirSync(prologDir, { withFileTypes: true })) {
        if (!artifact.isFile() || !artifact.name.startsWith("check-invariants_") || !artifact.name.endsWith(".json")) continue;
        const path = join(prologDir, artifact.name);
        try {
          const doc = JSON.parse(readFileSync(path, "utf-8"));
          const timestamp = doc.timestamp || statSync(path).mtime.toISOString();
          candidates.push({ path, doc, timestamp, time: Date.parse(timestamp) || statSync(path).mtimeMs });
        } catch {
          // Ignore malformed historical artifacts; status must remain best-effort.
        }
      }
    }
    candidates.sort((left, right) => right.time - left.time);
    return candidates[0] || null;
  }

  function assessCheckInvariantsArtifactFreshness(doc) {
    const recordedHashes = doc?.rule_hashes && typeof doc.rule_hashes === "object"
      ? doc.rule_hashes
      : {};
    const currentHashes = hashRuleFiles(skillPath);
    const recordedNames = Object.keys(recordedHashes);
    const currentNames = Object.keys(currentHashes);

    if (recordedNames.length === 0 || currentNames.length === 0) {
      return { status: "unverified", detail: "rule hashes unavailable" };
    }

    const changedNames = currentNames.filter((name) => recordedHashes[name] !== currentHashes[name]);
    const removedNames = recordedNames.filter((name) => !currentHashes[name]);
    if (changedNames.length > 0 || removedNames.length > 0) {
      return {
        status: "stale",
        detail: "rule bundle changed",
        changed_rule_count: changedNames.length + removedNames.length,
      };
    }

    return { status: "rule_bundle_current", detail: "rule bundle matches current code" };
  }

  function renderAmbientPersonaStatus(projectRoot = cwd) {
    let policyInfo;
    try {
      policyInfo = loadPlannerPolicy(projectRoot);
    } catch (error) {
      return `Ambient persona context: unavailable (planner policy read failed: ${error.message})`;
    }
    if (!policyInfo.valid) {
      return `Ambient persona context: unavailable (invalid planner policy: ${policyInfo.issues.join("; ")})`;
    }

    const policy = policyInfo.policy || DEFAULT_PLANNER_POLICY;
    const source = policyInfo.present ? relativeToProject(projectRoot, policyInfo.path) : "defaults";
    const lines = [];
    const personaSurface = policy?.persona?.ambient !== false && policy?.persona?.surface_on_session_start !== false;
    const iveSurface = policy?.ive?.ambient !== false && policy?.ive?.surface_on_session_start !== false;

    if (personaSurface) {
      try {
        const report = inferPersonaAdaptation(projectRoot);
        const obligations = [
          ...(report?.recommended_seed_roles || []),
          ...(report?.expected_companions || []),
        ];
        lines.push(`Ambient persona context: enabled (${source})`);
        lines.push(`Persona adaptation: ${report.status || "unknown"}`);
        lines.push(`   status: ${report.status || "unknown"} (confidence ${report.confidence || "unknown"})`);
        lines.push(`   active roles: ${compactList(report.configured_roles)}`);
        lines.push(`   domain profiles: ${compactList(report.domain_profiles)}`);
        lines.push(`   key obligations: ${compactList(obligations)}`);
        if (isProblematicPersonaStatus(report.status)) {
          lines.push(`   Repair: ${report.recommended_command}`);
        }
      } catch (error) {
        lines.push(`Ambient persona context: unavailable (persona scan failed: ${error.message})`);
      }
    }

    if (iveSurface) {
      const latest = findLatestCheckInvariantsArtifact(projectRoot);
      lines.push(`Ambient IVE context: enabled (${source})`);
      if (!latest) {
        lines.push("   latest invariant check: no check-invariants artifact found");
      } else {
        const ruleCount = Object.keys(latest.doc?.rule_hashes || {}).length;
        const violationCount = Number(latest.doc?.violation_count ?? (latest.doc?.violations || []).length ?? 0);
        const freshness = assessCheckInvariantsArtifactFreshness(latest.doc);
        lines.push(`   cached invariant evidence: ${ruleCount} rule file(s), ${violationCount} recorded violation(s), ${freshness.detail}, ${formatArtifactAge(latest.timestamp)}`);
        lines.push(`   artifact: ${relativeToProject(projectRoot, latest.path)}`);
        if (violationCount > 0) {
          lines.push("   current invariant state: not evaluated by bootstrap status");
          lines.push("   Resolve current state: node .agent/skills/iterative-planner/scripts/rule_engine.mjs check-invariants --json");
        }
      }
    }

    return lines.join("\n");
  }

  // Insight injection (ive-ontology-memory): resurface relevant prior insights/strategies
  // for the active plan so the agent reasons WITH them — routed advisory (one section),
  // trusted/derived only, never blocking. The positive half of long-term memory.
  async function renderRelevantInsightsSummary(planDirName) {
    if (!planDirName) return "";
    try {
      // Best-effort dynamic import: a stale target (mid-self-heal) may not yet have this
      // lib, and a missing optional capability must never break `bootstrap status`.
      const { loadKnowledgeTriggers, selectInsightInjections } = await import("./knowledge_triggers.mjs");
      const planDir = join(plansDir, planDirName);
      const stateJson = readStateJson(planDir);
      const planContent = existsSync(join(planDir, "plan.md")) ? readFileSync(join(planDir, "plan.md"), "utf-8") : "";
      const filesSection = planContent.match(/##\s+Files\s+[Tt]o\s+[Mm]odify\s*\n([\s\S]*?)(?=\n##|$)/);
      let plannedFiles = [];
      if (filesSection) {
        plannedFiles = (filesSection[1].match(/^\s*[-*]\s+`?([^`\s]+)`?/gm) || [])
          .map((line) => line.replace(/^\s*[-*]\s+`?/, "").replace(/`?\s*$/, "").trim())
          .filter(Boolean);
      }
      const loaded = loadKnowledgeTriggers();
      if (!loaded.ok) return "";
      const insights = selectInsightInjections(loaded.triggers, { goalText: stateJson?.goal || "", files: plannedFiles });
      if (insights.length === 0) return "";
      const lines = ["  Relevant prior insights (Knowledge Triggers):"];
      for (const a of insights) {
        lines.push(`  - [${a.id}] ${a.title}`);
        if (a.knowledge?.directive) lines.push(`      → ${a.knowledge.directive}${a.knowledge.prompt_ref ? ` (see ${a.knowledge.prompt_ref})` : ""}`);
        lines.push(`      matched_by: ${(a.matched_by || []).join(", ")}`);
      }
      return lines.join("\n");
    } catch {
      return "";
    }
  }

  async function renderDegradedCoverageStatus() {
    try {
      // Deliberately dynamic: bootstrap.mjs imports this context before managed
      // self-heal, so an older target must be able to repair the new helper first.
      const { assessDegradedCoverage, renderDegradedCoverageAssessment } = await import("./degraded_coverage.mjs");
      const assessment = assessDegradedCoverage({ cwd, skillPath });
      return renderDegradedCoverageAssessment(assessment, { indent: "  " });
    } catch (error) {
      return `  ❌ Degraded coverage assessment unavailable [GATE-COV-001]\n     ${error.message}`;
    }
  }

  // Forcing function (ive-ontology-memory ticket 5): resurface un-promoted draft Knowledge Triggers
  // at status so the operator can promote/discard them. Without this, captured drafts are invisible
  // (selectInsightInjections + evaluateObligationGate both filter non-trusted) and rot unpromoted —
  // the "advisory that isn't consumed becomes noise" failure. Best-effort dynamic import (a stale
  // self-heal target may lack the lib; an optional surface must never break `bootstrap status`).
  async function renderProposedDraftKtSummary() {
    try {
      const { listDraftTriggers } = await import("./knowledge_triggers.mjs");
      const drafts = listDraftTriggers();
      if (!drafts || drafts.length === 0) return "";
      const lines = [`  ${drafts.length} un-promoted draft Knowledge Trigger(s) — review/promote/discard:`];
      for (const d of drafts.slice(0, 8)) {
        lines.push(`  - [${d.kind}] ${d.id}: ${d.title}${d.proposed_from ? ` (from ${d.proposed_from})` : ""}`);
      }
      if (drafts.length > 8) lines.push(`  - … and ${drafts.length - 8} more`);
      lines.push(`     Promote: node .agent/skills/iterative-planner/scripts/knowledge_triggers.mjs --promote <id> --to derived|trusted`);
      return lines.join("\n");
    } catch {
      return "";
    }
  }

  function renderActivePersonaRecommendationSummary(planDirName) {
    if (!planDirName) return "";
    try {
      const planDir = join(plansDir, planDirName);
      const planPath = join(planDir, "plan.md");
      if (!existsSync(planPath)) return "";
      const synthesis = computeVerificationObligationSynthesis({
        cwd,
        planDir,
        stateJson: readStateJson(planDir),
        planContent: readFileSync(planPath, "utf-8"),
      });
      const lines = [];
      const artifactWarnings = (synthesis.persona_artifact_issues || synthesis.persona_summary?.issues || [])
        .map((issue) => formatPersonaArtifactIssue(issue))
        .filter(Boolean);
      if (artifactWarnings.length > 0) {
        lines.push("  Persona artifact diagnostics:");
        for (const warning of artifactWarnings) lines.push(`  - ${warning}`);
      }

      const artifactBackedSummary = renderPersonaTriggeredRecommendations(synthesis.obligations || [], { indent: "  " });
      if (artifactBackedSummary) {
        lines.push(artifactBackedSummary);
        return lines.join("\n");
      }

      const adaptation = inferPersonaAdaptation(cwd);
      const candidatePackIds = [
        ...(adaptation?.recommended_seed_roles || []),
        ...(adaptation?.expected_companions || []),
      ];
      const provisional = collectProvisionalPersonaTriggeredRecommendations(synthesis.obligations || [], {
        candidatePackIds,
        includeDefaultMappings: true,
      });
      const provisionalSummary = renderPersonaTriggeredRecommendations(provisional, {
        indent: "  ",
        precomputed: true,
      });
      if (provisionalSummary) lines.push(provisionalSummary);
      return lines.join("\n");
    } catch {
      return "";
    }
  }

  function renderActiveEvidenceGuidanceSummary(planDirName) {
    if (!planDirName) return "";
    try {
      const planDir = join(plansDir, planDirName);
      const planPath = join(planDir, "plan.md");
      if (!existsSync(planPath)) return "";
      const planContent = readFileSync(planPath, "utf-8");
      const synthesis = computeVerificationObligationSynthesis({
        cwd,
        planDir,
        stateJson: readStateJson(planDir),
        planContent,
      });
      const workOrderInfo = loadPlanWorkOrder(planDir);
      const workOrder = workOrderInfo.error ? null : workOrderInfo.parsed;
      const criteria = extractSuccessCriteria(planContent, { workOrder });
      const analysis = analyzeVerificationMatrix({ planContent, workOrder, criteria, synthesis });
      const guidance = buildVerificationEvidenceGuidance({
        analysis,
        synthesis,
        criteria,
        planArg: planDirName,
      });
      return renderEvidenceGuidance(guidance, { indent: "  ", compact: true });
    } catch {
      return "";
    }
  }

  // Ceremony-to-substance advisory: if the active plan dir has accreted far more
  // planner bookkeeping than the work warrants, surface it (never blocks). Fully
  // guarded — a failure here must never break `status`.
  function renderProportionalitySummary(planDirName) {
    if (!planDirName) return "";
    try {
      const planDir = join(plansDir, planDirName);
      const { lines, files } = measurePlanScaffolding(planDir);
      const verdict = proportionalityVerdict({ scaffoldingLines: lines });
      if (!verdict.over_threshold) return "";
      const top = files.slice(0, 3).map((f) => `${f.name} (${f.lines})`).join(", ");
      return `  ⚠️  ${verdict.message}\n     Largest: ${top}`;
    } catch {
      return "";
    }
  }

  function renderActiveOntologyPackGuardSummary(planDirName) {
    if (!planDirName) return "";
    try {
      const planDir = join(plansDir, planDirName);
      const planPath = join(planDir, "plan.md");
      const stateJson = readStateJson(planDir);
      const planContent = existsSync(planPath) ? readFileSync(planPath, "utf-8") : "";
      const goalText = stateJson?.goal || extractGoalFromPlanContent(planContent) || "";
      const plannedFiles = extractFilesToModify(planContent);
      const focusContract = deriveTaskFocusContract({
        cwd,
        planDir,
        goalText,
        plannedFiles,
      });
      const records = buildOntologyPackGuardContract({
        phase: "status",
        goalText,
        taskFocusContract: focusContract,
        plannedFiles,
        sourceFacts: [
          `active_plan:${planDirName}`,
          `state:${stateJson?.state || "unknown"}`,
        ],
      });
      return renderOntologyPackGuardSummary(records, { indent: "  " });
    } catch {
      return "";
    }
  }

  function renderActivePersonaAuthoritySummary(planDirName) {
    if (!planDirName) return "";
    try {
      const planDir = join(plansDir, planDirName);
      const planPath = join(planDir, "plan.md");
      const stateJson = readStateJson(planDir);
      const planContent = existsSync(planPath) ? readFileSync(planPath, "utf-8") : "";
      const goalText = stateJson?.goal || extractGoalFromPlanContent(planContent) || "";
      let auditConfig = {};
      try {
        const auditConfigPath = join(cwd, "audit.config.json");
        auditConfig = existsSync(auditConfigPath) ? JSON.parse(readFileSync(auditConfigPath, "utf-8")) : {};
      } catch {
        auditConfig = {};
      }

      const context = resolvePersonaAuthorityPlanContext({
        cwd,
        planDir,
        stateJson,
        planContent,
        goalText,
      });
      const roles = [...new Set([
        ...((Array.isArray(auditConfig.roles) ? auditConfig.roles : []).filter(Boolean)),
        ...((Array.isArray(auditConfig.force_packs) ? auditConfig.force_packs : []).filter(Boolean)),
      ])].filter((role) => role !== "core");
      if (roles.length === 0) return "";
      const summary = summarizePersonaAuthority(roles.map((role) => decidePersonaPackActivation(role, {
        planShape: context.plan_shape,
        forcePacks: auditConfig.force_packs || [],
        evidence: ["bootstrap_status"],
        taskFocusContract: context.task_focus_contract,
        suppressUnspecifiedDomainPacks: true,
      })));
      const rendered = renderPersonaAuthoritySummary(summary, { indent: "  " });
      let conflict = "";
      try {
        conflict = renderPersonaShapeSuppressionConflicts(inferPersonaAdaptation(cwd), summary, { indent: "  " });
      } catch {
        conflict = "";
      }
      return [rendered, conflict].filter(Boolean).join("\n");
    } catch {
      return "";
    }
  }

  function renderProjectPersonaAuthoritySummary(projectRoot = cwd) {
    try {
      let auditConfig = {};
      try {
        const auditConfigPath = join(projectRoot, "audit.config.json");
        auditConfig = existsSync(auditConfigPath) ? JSON.parse(readFileSync(auditConfigPath, "utf-8")) : {};
      } catch {
        auditConfig = {};
      }
      const roles = [...new Set([
        ...((Array.isArray(auditConfig.roles) ? auditConfig.roles : []).filter(Boolean)),
        ...((Array.isArray(auditConfig.force_packs) ? auditConfig.force_packs : []).filter(Boolean)),
      ])].filter((role) => role !== "core");
      if (roles.length === 0) return "";
      const projectShape = resolvePlannerPolicyShape(projectRoot);
      if (!projectShape) return "";
      const summary = summarizePersonaAuthority(roles.map((role) => decidePersonaPackActivation(role, {
        planShape: projectShape,
        forcePacks: auditConfig.force_packs || [],
        evidence: ["bootstrap_status", "project_policy"],
        suppressUnspecifiedDomainPacks: true,
      })));
      const rendered = renderPersonaAuthoritySummary(summary, { indent: "  " });
      let conflict = "";
      try {
        conflict = renderPersonaShapeSuppressionConflicts(inferPersonaAdaptation(projectRoot), summary, { indent: "  " });
      } catch {
        conflict = "";
      }
      return [rendered, conflict].filter(Boolean).join("\n");
    } catch {
      return "";
    }
  }

  async function renderActiveKnowledgeReceiptSummary(planDirName) {
    if (!planDirName) return "";
    try {
      const { buildKnowledgeReceipt, renderKnowledgeReceiptText } = await import("./knowledge_receipt.mjs");
      const planDir = join(plansDir, planDirName);
      const planPath = join(planDir, "plan.md");
      const statePath = join(planDir, "state.json");
      const stateJson = readStateJson(planDir);
      const planContent = existsSync(planPath) ? readFileSync(planPath, "utf-8") : "";
      const goalText = stateJson?.goal || extractGoalFromPlanContent(planContent) || "";
      let auditConfig = {};
      try {
        const auditConfigPath = join(cwd, "audit.config.json");
        auditConfig = existsSync(auditConfigPath) ? JSON.parse(readFileSync(auditConfigPath, "utf-8")) : {};
      } catch {
        auditConfig = {};
      }

      const context = resolvePersonaAuthorityPlanContext({
        cwd,
        planDir,
        stateJson,
        planContent,
        goalText,
      });
      const roles = [...new Set([
        ...((Array.isArray(auditConfig.roles) ? auditConfig.roles : []).filter(Boolean)),
        ...((Array.isArray(auditConfig.force_packs) ? auditConfig.force_packs : []).filter(Boolean)),
      ])].filter((role) => role !== "core");
      const personaAuthority = roles.length > 0
        ? summarizePersonaAuthority(roles.map((role) => decidePersonaPackActivation(role, {
            planShape: context.plan_shape,
            forcePacks: auditConfig.force_packs || [],
            evidence: ["bootstrap_status"],
            taskFocusContract: context.task_focus_contract,
            suppressUnspecifiedDomainPacks: true,
          })))
        : null;
      const activeState = String(stateJson?.state || "").toLowerCase();
      const baseArgs = {
        source: {
          surface: "bootstrap_status",
          kind: "active_plan",
          plan_dir: `plans/${planDirName}`,
        },
        planDir: `plans/${planDirName}`,
        sourceText: [goalText, planContent].filter(Boolean).join("\n\n"),
        planContent,
        personaPacks: roles,
        personaAuthority,
        remainingUnverifiedRisk: activeState && !["close", "closed"].includes(activeState)
          ? [{
              id: `active_plan_${activeState}_proof_pending`,
              status: "pending",
              reason: "Active plan has not completed validate-to-close and notify-user.",
            }]
          : [],
      };
      const baseReceipt = buildKnowledgeReceipt(baseArgs);
      if (!baseReceipt.has_content) return "";
      const receipt = buildKnowledgeReceipt({
        ...baseArgs,
        artifactRefs: [
          { kind: "plan", path: relative(cwd, planPath) },
          { kind: "state", path: relative(cwd, statePath) },
        ],
      });
      return renderKnowledgeReceiptText(receipt, { indent: "  " });
    } catch {
      return "";
    }
  }

  return {
    renderAmbientPersonaStatus,
    renderDegradedCoverageStatus,
    renderRelevantInsightsSummary,
    renderProposedDraftKtSummary,
    renderActivePersonaRecommendationSummary,
    renderActiveEvidenceGuidanceSummary,
    renderProportionalitySummary,
    renderActiveOntologyPackGuardSummary,
    renderActivePersonaAuthoritySummary,
    renderProjectPersonaAuthoritySummary,
    renderActiveKnowledgeReceiptSummary,
  };
}
