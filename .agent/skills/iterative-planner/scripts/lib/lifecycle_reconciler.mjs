// @planner:module = lifecycle_reconciler
// @planner:capability = advisory_program_packet_lifecycle_reconciliation

import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import {
  effectiveTicketLifecycle,
  isDispositionResolvedTicket,
  resolveProgramPacketPath,
  validateAwaitingExternalAction,
} from "./program_packet.mjs";
import { extractRepoStateStampFromObject } from "./repo_state_stamp.mjs";
import {
  collectStagedCloseEvidence,
  collectTrustedLifecycleCommitEvidence,
  canonicalLifecyclePlanDir,
  LIFECYCLE_GIT_CANDIDATE_LIMIT,
  planGoalReferencesTicket,
  readPlanDeliveryScope,
} from "./lifecycle_delivery_evidence.mjs";

const OPEN_LIFECYCLES = new Set(["proposed", "ready", "in_progress", "executing", "done"]);
const CLOSED_PLAN_STATES = new Set(["close", "closed"]);
const FINAL_TICKET_LIFECYCLES = new Set(["verified", "closed", "deferred", "blocked"]);
const MAX_ARTIFACT_BYTES = 512 * 1024;
const DEFAULT_REPORT_DIR = join("reports", "ive", "lifecycle_reconciliation");
const DEFAULT_GIT_LIMIT = LIFECYCLE_GIT_CANDIDATE_LIMIT;
const MAX_EXPECTED_EVIDENCE_FILES = 500;

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "after", "before",
  "using", "ticket", "tickets", "program", "packet", "intake", "implement", "repair",
  "repairs", "make", "must", "should", "source", "review", "scope", "change",
  "proposed", "provenance", "evidence", "proof", "state", "plan", "plans",
]);

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function rel(cwd, filePath) {
  return normalizePath(relative(cwd, filePath));
}

function unique(values) {
  return [...new Set(asArray(values).map(asString).filter(Boolean))];
}

function safeReadText(path) {
  try {
    if (!existsSync(path)) return null;
    const st = statSync(path);
    if (!st.isFile()) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function safeParseJson(path) {
  const text = safeReadText(path);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizedPlanState(state) {
  const transitions = asArray(state.transitions);
  const lastTransition = transitions.at(-1);
  if (asString(lastTransition?.marker).toUpperCase() === "[ABANDONED]") return "abandoned";
  return asString(state.state).toLowerCase();
}

function jsonMatch(document, expected) {
  if (!document || typeof document !== "object" || Array.isArray(document)) return false;
  return Object.entries(expected || {}).every(([key, value]) => Object.is(document[key], value));
}

function findExpectedJsonEvidence(cwd, expectedEvidence) {
  const lexicalRoot = resolve(cwd, expectedEvidence.root);
  const rootExists = existsSync(lexicalRoot);
  const root = rootExists ? realpathSync(lexicalRoot) : lexicalRoot;
  const comparisonCwd = rootExists ? realpathSync(cwd) : resolve(cwd);
  const relativeRoot = normalizePath(relative(comparisonCwd, root));
  if (!relativeRoot || relativeRoot === ".." || relativeRoot.startsWith("../") || isAbsolute(relativeRoot)) {
    return { found: false, complete: false, matched_path: null, files_scanned: 0, warning: "unsafe_root" };
  }
  if (!rootExists) {
    return { found: false, complete: true, matched_path: null, files_scanned: 0, warning: "root_missing" };
  }

  const queue = [root];
  let filesScanned = 0;
  let scanIncomplete = false;
  while (queue.length > 0 && filesScanned < MAX_EXPECTED_EVIDENCE_FILES) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true })
        .filter((entry) => !entry.isSymbolicLink())
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      scanIncomplete = true;
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      filesScanned += 1;
      let st;
      try {
        st = statSync(path);
      } catch {
        scanIncomplete = true;
        continue;
      }
      if (st.size > MAX_ARTIFACT_BYTES) continue;
      const raw = safeReadText(path);
      if (raw === null) {
        scanIncomplete = true;
        continue;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (jsonMatch(parsed, expectedEvidence.match)) {
        return {
          found: true,
          complete: true,
          matched_path: rel(cwd, path),
          files_scanned: filesScanned,
          warning: null,
        };
      }
      if (filesScanned >= MAX_EXPECTED_EVIDENCE_FILES) break;
    }
  }
  return {
    found: false,
    complete: !scanIncomplete && filesScanned < MAX_EXPECTED_EVIDENCE_FILES,
    matched_path: null,
    files_scanned: filesScanned,
    warning: filesScanned >= MAX_EXPECTED_EVIDENCE_FILES
      ? "scan_limit_reached"
      : (scanIncomplete ? "scan_incomplete" : null),
  };
}

function nowIso(clock = () => new Date()) {
  return clock().toISOString();
}

function reportStamp(timestamp) {
  return String(timestamp || nowIso()).replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function ticketLabel(ticket) {
  const title = asString(ticket?.title);
  const match = title.match(/^\s*([A-Z][0-9]+(?:-[0-9]+)?)\s*:/i);
  return match ? match[1].toUpperCase() : null;
}

function stemToken(token) {
  const value = String(token || "").toLowerCase();
  if (value.endsWith("ies") && value.length > 5) return `${value.slice(0, -3)}y`;
  if (value.endsWith("s") && value.length > 4) return value.slice(0, -1);
  return value;
}

function tokens(value) {
  return unique(String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map(stemToken)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token)));
}

function tokenSet(value) {
  return new Set(tokens(value));
}

function overlap(left, right) {
  const a = left instanceof Set ? left : tokenSet(left);
  const b = right instanceof Set ? right : tokenSet(right);
  const shared = [];
  for (const token of a) {
    if (b.has(token)) shared.push(token);
  }
  return shared.sort();
}

function ticketSearchText(ticket) {
  return [
    ticket?.id,
    ticket?.title,
    ticket?.problem,
    ticket?.proposed_change,
    asArray(ticket?.acceptance_criteria).join(" "),
    asArray(ticket?.verification_refs).join(" "),
  ].map(asString).filter(Boolean).join("\n");
}

function labelBoundaryPattern(label) {
  const escaped = String(label || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(^|[^A-Za-z0-9-])${escaped}([^A-Za-z0-9-]|$)`;
}

function unitSearchText(unit) {
  return [
    unit?.id,
    unit?.title,
    unit?.text,
  ].map(asString).filter(Boolean).join("\n");
}

function hashObject(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function decisionsById(packet) {
  return new Map(asArray(packet?.decisions).map((decision) => [asString(decision?.id), decision]).filter(([id]) => id));
}

function claimsProposedResolution(ticket) {
  return ["resolved_by_evidence", "resolved_by_investigation"].includes(
    asString(ticket?.backlog_disposition?.classification).toLowerCase(),
  );
}

export function listProgramPacketPaths(cwd = process.cwd()) {
  const programsDir = join(cwd, "plans", "programs");
  if (!existsSync(programsDir)) return [];
  return readdirSync(programsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(programsDir, entry.name, "program_packet.json"))
    .filter((path) => existsSync(path))
    .sort();
}

function resolveProgramPath(cwd, program) {
  const raw = asString(program);
  if (!raw) return null;
  const resolved = resolveProgramPacketPath({ cwd, program: raw });
  if (resolved.status === "FOUND" && resolved.path && existsSync(resolved.path)) return resolved.path;
  throw new Error(resolved.message || `Program Packet not found: ${raw}`);
}

function loadProgramPackets(cwd) {
  const packets = [];
  const warnings = [];
  for (const packetPath of listProgramPacketPaths(cwd)) {
    const parsed = safeParseJson(packetPath);
    if (!parsed) {
      warnings.push({
        code: "program_packet_unreadable",
        path: rel(cwd, packetPath),
        message: "Program Packet JSON could not be parsed",
      });
      continue;
    }
    packets.push({
      path: packetPath,
      packet_path: rel(cwd, packetPath),
      packet: parsed,
      program_id: asString(parsed.id) || rel(cwd, dirname(packetPath)),
      program_title: asString(parsed.title),
    });
  }
  return { packets, warnings };
}

function loadPlanRecords(cwd) {
  const plansDir = join(cwd, "plans");
  if (!existsSync(plansDir)) return [];
  const candidatePlanDirs = readdirSync(plansDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("plan_"))
    .map((entry) => join(plansDir, entry.name));
  const programsDir = join(plansDir, "programs");
  if (existsSync(programsDir)) {
    for (const programEntry of readdirSync(programsDir, { withFileTypes: true })) {
      if (!programEntry.isDirectory()) continue;
      const childPlansDir = join(programsDir, programEntry.name, "child_plans");
      if (!existsSync(childPlansDir)) continue;
      for (const childEntry of readdirSync(childPlansDir, { withFileTypes: true })) {
        if (childEntry.isDirectory()) candidatePlanDirs.push(join(childPlansDir, childEntry.name));
      }
    }
  }
  const records = [];
  for (const planDir of candidatePlanDirs.sort()) {
    const statePath = join(planDir, "state.json");
    const state = safeParseJson(statePath);
    if (!state) continue;
    const summaryPath = join(planDir, "summary.md");
    const verificationPath = join(planDir, "verification.md");
    const findingsPath = join(planDir, "findings.md");
    const summary = safeReadText(summaryPath) || "";
    const verification = safeReadText(verificationPath) || "";
    const findings = safeReadText(findingsPath) || "";
    const scope = readPlanDeliveryScope({ cwd, planDir: rel(cwd, planDir) });
    records.push({
      plan_dir: rel(cwd, planDir),
      state: normalizedPlanState(state),
      goal: asString(state.goal),
      state_path: rel(cwd, statePath),
      summary_path: existsSync(summaryPath) ? rel(cwd, summaryPath) : null,
      text: [state.goal, summary, verification, findings].map(asString).join("\n"),
      closing_text: asString(state.goal),
      scope_path: scope.scope_path,
      delivery_files: scope.delivery_files,
      scope_diagnostics: asArray(scope.diagnostics),
    });
  }
  return records.sort((a, b) => a.plan_dir.localeCompare(b.plan_dir));
}

function collectRepoState(cwd) {
  const headProc = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd,
    encoding: "utf-8",
    timeout: 5000,
  });
  const statusProc = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd,
    encoding: "utf-8",
    timeout: 10000,
  });
  const dirty_files = statusProc.status === 0
    ? String(statusProc.stdout || "").split("\n").map((line) => line.slice(3).trim()).filter(Boolean)
    : [];
  return {
    head: headProc.status === 0 ? asString(headProc.stdout) : null,
    dirty: dirty_files.length > 0,
    dirty_files: dirty_files.slice(0, 200),
    dirty_file_count: dirty_files.length,
    warning: dirty_files.length > 0
      ? "Worktree is dirty; reconciliation remains advisory and does not treat current dirty files as shipped proof."
      : null,
  };
}

function findStampedArtifactsForTicket(cwd, ticketId, candidateRoots = []) {
  const roots = unique(candidateRoots)
    .map((path) => isAbsolute(path) ? path : join(cwd, path))
    .map((path) => join(path, "artifacts"))
    .filter((path) => existsSync(path));
  const found = [];
  const stack = [...roots];
  while (stack.length > 0 && found.length < 20) {
    const current = stack.pop();
    let st;
    try {
      st = statSync(current);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const name = current.split(/[\\/]/).pop();
      if (["node_modules", ".git"].includes(name)) continue;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.name.endsWith(".json") || entry.name.endsWith(".jsonl")) stack.push(join(current, entry.name));
      }
      continue;
    }
    if (!st.isFile() || st.size > MAX_ARTIFACT_BYTES || (!current.endsWith(".json") && !current.endsWith(".jsonl"))) continue;
    const raw = safeReadText(current);
    if (!raw || !raw.includes(ticketId) || !/repo_state|repoState|repo_state_stamp|repoStateStamp/.test(raw)) continue;
    const parsedObjects = current.endsWith(".jsonl")
      ? raw.split("\n").map((line) => {
        if (!line.trim()) return null;
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean)
      : [safeParseJson(current)].filter(Boolean);
    const parsed = parsedObjects.find((item) => JSON.stringify(item).includes(ticketId) && extractRepoStateStampFromObject(item));
    if (!parsed) continue;
    const stamp = extractRepoStateStampFromObject(parsed);
    const canonical = Boolean(parsed?.repo_state_stamp);
    found.push({
      kind: "stamped_receipt",
      status: "supporting",
      path: rel(cwd, current),
      detail: canonical
        ? "Canonical repo_state_stamp receipt references ticket id and repo-state provenance."
        : "Legacy repo-state receipt references ticket id and repo-state provenance.",
      stamp_schema: stamp?.schema_version || (canonical ? "repo_state_stamp" : "legacy_repo_state"),
      stamp_head_sha: stamp?.head_sha || stamp?.head || null,
      dirty_file_count: Number.isFinite(stamp?.dirty_file_count) ? stamp.dirty_file_count : null,
      stamp_hash: hashObject(stamp),
      trusted_shipment: false,
    });
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

function findPlanEvidence(cwd, ticket, plans) {
  const ticketId = asString(ticket?.id);
  const declaredPlanRaw = asString(ticket?.child_plan?.plan_dir);
  const hasDeclaredPlan = !!declaredPlanRaw;
  const directPlanDir = canonicalLifecyclePlanDir(cwd, declaredPlanRaw);
  const evidence = [];
  let declaredPlanFound = false;
  for (const plan of plans) {
    const planStateClosed = CLOSED_PLAN_STATES.has(plan.state);
    const direct = !!directPlanDir && normalizePath(plan.plan_dir) === directPlanDir;
    if (direct) declaredPlanFound = true;
    const exact = !hasDeclaredPlan && planGoalReferencesTicket(plan.closing_text, ticketId);
    if (!direct && !exact) continue;
    evidence.push({
      kind: direct ? "declared_child_plan" : (planStateClosed ? "closed_plan_match" : "plan_match"),
      status: planStateClosed ? "closed" : plan.state || "unknown",
      path: plan.plan_dir,
      detail: direct
        ? `Declared child_plan.plan_dir is ${plan.state || "unknown"}.`
        : `${planStateClosed ? "Closed" : "Matched"} plan goal references ${ticketId}.`,
      state_path: plan.state_path,
      summary_path: plan.summary_path,
      closes_lifecycle: planStateClosed,
      scope_path: plan.scope_path,
      delivery_files: plan.delivery_files,
      diagnostics: plan.scope_diagnostics,
    });
  }
  if (hasDeclaredPlan && !declaredPlanFound) {
    const invalid = !directPlanDir;
    evidence.push({
      kind: invalid ? "declared_child_plan_invalid" : "declared_child_plan_missing",
      status: invalid ? "invalid" : "missing",
      path: directPlanDir || declaredPlanRaw,
      detail: invalid
        ? "Declared child_plan.plan_dir is outside the supported canonical plan roots."
        : "Declared child_plan.plan_dir has no readable canonical state record.",
      closes_lifecycle: false,
      diagnostics: [invalid ? "canonical_declared_plan_path_invalid" : "canonical_declared_plan_missing"],
    });
  }
  return evidence;
}

function selectedLifecyclePlanEvidence(planEvidence) {
  const declared = planEvidence.find((entry) => entry.kind === "declared_child_plan");
  if (declared) return declared.closes_lifecycle === true ? declared : null;
  return planEvidence.find((entry) => entry.closes_lifecycle === true) || null;
}

function shouldConsiderTicket(ticket, packet, cwd, programPacketPath) {
  const lifecycle = effectiveTicketLifecycle(ticket?.lifecycle);
  if (isDispositionResolvedTicket(ticket, {
    decisionsById: decisionsById(packet),
    cwd,
    programId: packet.id,
    programPacketPath,
  })) return false;
  if (["closed", "deferred"].includes(lifecycle) && claimsProposedResolution(ticket)) return true;
  if (lifecycle === "blocked") return true;
  if (!lifecycle || FINAL_TICKET_LIFECYCLES.has(lifecycle)) return false;
  return OPEN_LIFECYCLES.has(lifecycle) || !FINAL_TICKET_LIFECYCLES.has(lifecycle);
}

function buildLifecycleFindings({ cwd, packets, plans, includeStampedArtifacts, gitLimit }) {
  const findings = [];
  const awaitingExternalAction = [];
  const stagedClose = [];
  const warnings = [];
  for (const program of packets) {
    for (const ticket of asArray(program.packet?.tickets)) {
      if (!shouldConsiderTicket(ticket, program.packet, cwd, program.path)) continue;
      const ticketId = asString(ticket?.id);
      if (!ticketId) continue;
      const planEvidence = findPlanEvidence(cwd, ticket, plans);
      warnings.push(...planEvidence.flatMap((entry) => asArray(entry.diagnostics).map((code) => ({
        code,
        path: entry.path,
        message: `Lifecycle plan evidence diagnostic for ${ticketId}`,
      }))));
      const selectedPlan = selectedLifecyclePlanEvidence(planEvidence);
      if (!selectedPlan) continue;
      const commitResult = collectTrustedLifecycleCommitEvidence({
        cwd,
        ticketId,
        deliveryFiles: selectedPlan.delivery_files,
        planDir: selectedPlan.path,
        limit: gitLimit,
      });
      const commitEvidence = commitResult.evidence;
      warnings.push(...commitResult.warnings.map((code) => ({
        code,
        path: selectedPlan.path,
        message: `Trusted commit evidence could not be fully queried for ${ticketId}`,
      })));
      const stampedEvidence = includeStampedArtifacts
        ? findStampedArtifactsForTicket(cwd, ticketId, planEvidence.map((entry) => entry.path))
        : [];
      if (commitEvidence.length === 0) {
        const staged = collectStagedCloseEvidence({ cwd, ticketId, planDir: selectedPlan.path });
        warnings.push(...asArray(staged.diagnostics).map((code) => ({
          code,
          path: selectedPlan.path,
          message: `Staged-close evidence could not be fully queried for ${ticketId}`,
        })));
        if (staged.qualified) {
          stagedClose.push({
            id: `staged_close:${ticketId}`,
            ...staged,
            ticket_title: asString(ticket.title),
            program_id: program.program_id,
            program_title: program.program_title,
            packet_path: program.packet_path,
            current_lifecycle: effectiveTicketLifecycle(ticket.lifecycle),
            proposed_lifecycle: null,
            evidence_chain: [selectedPlan, staged],
          });
        }
        continue;
      }
      const evidence_chain = [
        ...stampedEvidence,
        ...planEvidence,
        ...commitEvidence,
      ];
      const proposed_lifecycle = "closed";
      const awaiting = ticket.awaiting_external_action === undefined
        ? null
        : validateAwaitingExternalAction(ticket.awaiting_external_action, { lifecycle: ticket.lifecycle });
      const expectedEvidence = awaiting?.ok
        ? findExpectedJsonEvidence(cwd, awaiting.normalized.expected_evidence)
        : null;
      if (awaiting?.ok && expectedEvidence && !expectedEvidence.found && expectedEvidence.complete) {
        awaitingExternalAction.push({
          id: `awaiting_external_action:${ticketId}`,
          kind: "awaiting_external_action",
          status: "active",
          ticket_id: ticketId,
          ticket_title: asString(ticket.title),
          program_id: program.program_id,
          program_title: program.program_title,
          packet_path: program.packet_path,
          current_lifecycle: effectiveTicketLifecycle(ticket.lifecycle),
          action_kind: awaiting.normalized.kind,
          reason: awaiting.normalized.reason,
          recorded_at: awaiting.normalized.recorded_at,
          expected_evidence: {
            ...awaiting.normalized.expected_evidence,
            files_scanned: expectedEvidence.files_scanned,
            complete: expectedEvidence.complete,
            warning: expectedEvidence.warning,
          },
          suppressed_finding: {
            kind: "shipped_open_ticket",
            proposed_lifecycle,
            evidence_kinds: evidence_chain.map((entry) => entry.kind),
          },
        });
        continue;
      }
      if (expectedEvidence?.found) {
        evidence_chain.unshift({
          kind: "expected_external_evidence",
          status: "matched",
          path: expectedEvidence.matched_path,
          detail: "Declared awaiting_external_action evidence now exists; exemption expired.",
          files_scanned: expectedEvidence.files_scanned,
        });
      } else if (awaiting?.ok && expectedEvidence && !expectedEvidence.complete) {
        evidence_chain.unshift({
          kind: "expected_external_evidence_scan",
          status: "incomplete",
          path: awaiting.normalized.expected_evidence.root,
          detail: `Declared evidence scan was incomplete (${expectedEvidence.warning}); exemption not granted.`,
          files_scanned: expectedEvidence.files_scanned,
        });
      }
      findings.push({
        id: `lifecycle:${ticketId}`,
        kind: "shipped_open_ticket",
        severity: "advisory",
        ticket_id: ticketId,
        ticket_title: asString(ticket.title),
        program_id: program.program_id,
        program_title: program.program_title,
        packet_path: program.packet_path,
        current_lifecycle: effectiveTicketLifecycle(ticket.lifecycle),
        proposed_lifecycle,
        awaiting_external_action: expectedEvidence?.found
          ? { status: "expired", matched_path: expectedEvidence.matched_path }
          : (awaiting?.ok && expectedEvidence && !expectedEvidence.complete
            ? { status: "indeterminate", warning: expectedEvidence.warning }
            : null),
        evidence_chain,
        repair: {
          action: "operator_review_lifecycle_update",
          patch_not_applied: true,
          proposed_change: {
            lifecycle: proposed_lifecycle,
          },
        },
      });
    }
  }
  return {
    findings: findings.sort((a, b) => `${a.packet_path}:${a.ticket_id}`.localeCompare(`${b.packet_path}:${b.ticket_id}`)),
    awaiting_external_action: awaitingExternalAction.sort((a, b) => `${a.packet_path}:${a.ticket_id}`.localeCompare(`${b.packet_path}:${b.ticket_id}`)),
    staged_close: stagedClose.sort((a, b) => `${a.packet_path}:${a.ticket_id}`.localeCompare(`${b.packet_path}:${b.ticket_id}`)),
    warnings,
  };
}

function collectScopeUnits(packets) {
  const units = [];
  for (const program of packets) {
    for (const ticket of asArray(program.packet?.tickets)) {
      units.push({
        kind: "ticket",
        id: asString(ticket.id),
        title: asString(ticket.title),
        text: ticketSearchText(ticket),
        program_id: program.program_id,
        program_title: program.program_title,
        packet_path: program.packet_path,
      });
    }
    for (const decision of asArray(program.packet?.decisions)) {
      units.push({
        kind: "decision",
        id: asString(decision.id) || asString(decision.title) || "decision",
        title: asString(decision.title),
        text: [decision.title, decision.decision, decision.rationale, decision.notes].map(asString).filter(Boolean).join("\n"),
        program_id: program.program_id,
        program_title: program.program_title,
        packet_path: program.packet_path,
      });
    }
  }
  return units;
}

function titleSimilarity(leftTitle, rightTitle) {
  const left = tokenSet(leftTitle);
  const right = tokenSet(rightTitle);
  const shared = overlap(left, right).length;
  const union = new Set([...left, ...right]).size || 1;
  return shared / union;
}

export function duplicateConfidence({ sharedLabel, sharedTokens, unitKind, titleScore, batchLabelHit }) {
  if (!sharedLabel) return "low";
  if (unitKind === "ticket" && titleScore < 0.45) return "low";
  if (unitKind === "decision" && !batchLabelHit && titleScore < 0.35) return "low";
  if (sharedLabel && sharedTokens.length >= 3) return "high";
  if (batchLabelHit && sharedTokens.length >= 2) return "medium";
  return "low";
}

function buildDuplicateFindings({ cwd, packets }) {
  const units = collectScopeUnits(packets);
  const findings = [];
  const seen = new Set();
  for (const program of packets) {
    for (const ticket of asArray(program.packet?.tickets)) {
      if (!shouldConsiderTicket(ticket, program.packet, cwd, program.path)) continue;
      const ticketId = asString(ticket?.id);
      if (!ticketId) continue;
      const label = ticketLabel(ticket);
      const targetTokens = tokenSet(ticket?.title);
      for (const unit of units) {
        if (unit.packet_path === program.packet_path) continue;
        const unitText = unitSearchText(unit);
        const sharedTokens = overlap(targetTokens, tokenSet(unitText));
        const sharedLabel = label
          ? new RegExp(labelBoundaryPattern(label), "i").test(unitText)
          : false;
        const batchLabelHit = label
          ? new RegExp(`(${String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!-)\\s*/|/\\s*${String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![-A-Za-z0-9]))`, "i").test(unitText)
          : false;
        const titleScore = titleSimilarity(ticket?.title, unit.title);
        const confidence = duplicateConfidence({
          sharedLabel,
          sharedTokens,
          unitKind: unit.kind,
          titleScore,
          batchLabelHit,
        });
        if (confidence === "low") continue;
        const key = `${ticketId}:${unit.packet_path}:${unit.kind}:${unit.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          id: `duplicate:${ticketId}:${hashObject([unit.packet_path, unit.kind, unit.id])}`,
          kind: "cross_program_duplicate_scope",
          severity: "advisory",
          confidence,
          ticket_id: ticketId,
          ticket_title: asString(ticket.title),
          program_id: program.program_id,
          packet_path: program.packet_path,
          current_lifecycle: effectiveTicketLifecycle(ticket.lifecycle),
          matched_scope: {
            kind: unit.kind,
            id: unit.id,
            title: unit.title,
            program_id: unit.program_id,
            packet_path: unit.packet_path,
          },
          evidence_chain: [{
            kind: "scope_overlap",
            status: confidence,
            path: unit.packet_path,
            detail: sharedLabel
              ? `Shared scope label ${label} and ${sharedTokens.length} token(s).`
              : `Shared ${sharedTokens.length} scope token(s).`,
            shared_label: sharedLabel ? label : null,
            batch_label_hit: batchLabelHit,
            title_similarity: Number(titleScore.toFixed(3)),
            shared_tokens: sharedTokens.slice(0, 20),
          }],
          repair: {
            action: "operator_review_scope_consolidation",
            patch_not_applied: true,
          },
        });
      }
    }
  }
  return findings.sort((a, b) => `${a.ticket_id}:${a.matched_scope.packet_path}`.localeCompare(`${b.ticket_id}:${b.matched_scope.packet_path}`));
}

function defaultReportPath(cwd, timestamp) {
  return join(cwd, DEFAULT_REPORT_DIR, `lifecycle_reconciliation_${reportStamp(timestamp)}.json`);
}

function finalizeReport(report) {
  const shipped = asArray(report.findings?.shipped_open);
  const duplicate = asArray(report.findings?.duplicate_scope);
  const awaiting = asArray(report.exemptions?.awaiting_external_action);
  const stagedClose = asArray(report.pending?.staged_close);
  const counts = {
    programs_scanned: asArray(report.programs).length,
    tickets_scanned: Number(report.counts?.tickets_scanned || 0),
    shipped_open_findings: shipped.length,
    duplicate_scope_findings: duplicate.length,
    advisory_findings: shipped.length + duplicate.length,
    awaiting_external_action_exemptions: awaiting.length,
    staged_close_pending_commit: stagedClose.length,
  };
  return {
    ...report,
    counts,
    status: "ADVISORY",
  };
}

export function buildLifecycleReconciliationReport(options = {}) {
  const requestedCwd = resolve(options.cwd || process.cwd());
  const cwd = existsSync(requestedCwd) ? realpathSync(requestedCwd) : requestedCwd;
  const timestamp = asString(options.timestamp) || nowIso(options.clock);
  const { packets: allPackets, warnings } = loadProgramPackets(cwd);
  const selectedPath = asString(options.program) ? resolveProgramPath(cwd, options.program) : null;
  const selectedRel = selectedPath ? normalizePath(rel(cwd, realpathSync(selectedPath))) : null;
  const packets = selectedRel
    ? allPackets.filter((packet) => normalizePath(rel(cwd, realpathSync(packet.path))) === selectedRel)
    : allPackets;
  if (selectedRel && packets.length !== 1) {
    throw new Error(`Program filter did not resolve exactly once: ${asString(options.program)}`);
  }
  const plans = loadPlanRecords(cwd);
  const repoState = collectRepoState(cwd);
  const lifecycle = buildLifecycleFindings({
    cwd,
    packets,
    plans,
    includeStampedArtifacts: options.includeStampedArtifacts !== false,
    gitLimit: options.gitLimit || DEFAULT_GIT_LIMIT,
  });
  const baseReportPath = options.output
    ? (isAbsolute(options.output) ? options.output : resolve(cwd, options.output))
    : defaultReportPath(cwd, timestamp);
  const duplicateScope = buildDuplicateFindings({ cwd, packets: allPackets });
  const filteredDuplicateScope = selectedRel
    ? duplicateScope.filter((finding) =>
      normalizePath(finding.packet_path) === selectedRel
      || normalizePath(finding.matched_scope?.packet_path) === selectedRel)
    : duplicateScope;
  const report = finalizeReport({
    version: 1,
    generated_at: timestamp,
    mode: "advisory_only",
    repo_state: repoState,
    program_filter: selectedRel ? {
      requested: asString(options.program),
      packet_path: selectedRel,
    } : null,
    programs: packets.map((packet) => ({
      id: packet.program_id,
      title: packet.program_title,
      packet_path: packet.packet_path,
    })),
    counts: {
      tickets_scanned: packets.reduce((total, program) => total + asArray(program.packet?.tickets).length, 0),
    },
    warnings: [
      ...warnings,
      ...lifecycle.warnings,
      ...(repoState.warning ? [{ code: "dirty_worktree", path: ".", message: repoState.warning }] : []),
    ],
    findings: {
      shipped_open: lifecycle.findings,
      duplicate_scope: filteredDuplicateScope,
    },
    exemptions: {
      awaiting_external_action: lifecycle.awaiting_external_action,
    },
    pending: {
      staged_close: lifecycle.staged_close,
    },
    repair_packet: {
      path: rel(cwd, baseReportPath),
      written: false,
      write_requested: options.write === true,
    },
  });
  const writePath = options.output
    ? (isAbsolute(options.output) ? options.output : resolve(cwd, options.output))
    : resolve(cwd, report.repair_packet.path);
  const finalReport = {
    ...report,
    repair_packet: {
      ...report.repair_packet,
      path: rel(cwd, writePath),
      written: false,
      write_requested: options.write === true,
    },
  };
  if (options.write === true) {
    mkdirSync(dirname(writePath), { recursive: true });
    const payload = { ...finalReport, repair_packet: { ...finalReport.repair_packet, written: true } };
    writeFileSync(writePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    return payload;
  }
  return finalReport;
}

export function lifecycleReconciliationSummary(report) {
  const counts = report?.counts || {};
  return {
    status: report?.status || "UNKNOWN",
    advisory_findings: counts.advisory_findings || 0,
    shipped_open_findings: counts.shipped_open_findings || 0,
    duplicate_scope_findings: counts.duplicate_scope_findings || 0,
    awaiting_external_action_exemptions: counts.awaiting_external_action_exemptions || 0,
    staged_close_pending_commit: counts.staged_close_pending_commit || 0,
    repair_packet_path: report?.repair_packet?.path || null,
    repair_packet_written: report?.repair_packet?.written === true,
    dirty_worktree: report?.repo_state?.dirty === true,
    warning_count: asArray(report?.warnings).length,
  };
}

export function renderLifecycleReconciliationStatusLine(summaryOrReport) {
  const summary = summaryOrReport?.counts
    ? lifecycleReconciliationSummary(summaryOrReport)
    : summaryOrReport;
  if (!summary || (summary.advisory_findings <= 0 && summary.awaiting_external_action_exemptions <= 0 && summary.staged_close_pending_commit <= 0)) return "";
  const writeState = summary.repair_packet_written ? "written" : "not written";
  const dirty = summary.dirty_worktree ? "; dirty proof warning" : "";
  return `  Lifecycle reconciliation: ${summary.advisory_findings} advisory finding(s) (${summary.shipped_open_findings} shipped-open, ${summary.duplicate_scope_findings} duplicate-scope); ${summary.staged_close_pending_commit} staged-close pending-commit record(s); ${summary.awaiting_external_action_exemptions} awaiting-external-action exemption(s); repair packet: ${summary.repair_packet_path || "not available"} (${writeState}${dirty})`;
}

export function renderLifecycleReconciliationText(report) {
  const summary = lifecycleReconciliationSummary(report);
  const lines = [
    "Lifecycle reconciliation: ADVISORY",
    `Findings: ${summary.advisory_findings} (${summary.shipped_open_findings} shipped-open, ${summary.duplicate_scope_findings} duplicate-scope)`,
    `Staged close pending commit: ${summary.staged_close_pending_commit} record(s)`,
    `Awaiting external action: ${summary.awaiting_external_action_exemptions} active exemption(s)`,
    `Repair packet: ${summary.repair_packet_path || "not available"} (${summary.repair_packet_written ? "written" : "not written"})`,
  ];
  if (summary.dirty_worktree) lines.push("Warning: dirty worktree; current dirty files are not treated as shipped proof.");
  for (const finding of asArray(report?.findings?.shipped_open).slice(0, 8)) {
    const evidenceKinds = asArray(finding.evidence_chain).map((entry) => entry.kind).join(", ");
    lines.push(`- ${finding.ticket_id} [${finding.current_lifecycle} -> ${finding.proposed_lifecycle}] ${finding.ticket_title} (${evidenceKinds})`);
  }
  const remaining = Math.max(0, (summary.shipped_open_findings || 0) - 8);
  if (remaining) lines.push(`- ... ${remaining} more shipped-open finding(s)`);
  for (const pending of asArray(report?.pending?.staged_close).slice(0, 8)) {
    lines.push(`- ${pending.ticket_id} [${pending.current_lifecycle}; staged-close pending commit] ${pending.ticket_title} (${pending.index_fingerprint})`);
  }
  for (const exemption of asArray(report?.exemptions?.awaiting_external_action).slice(0, 8)) {
    lines.push(`- ${exemption.ticket_id} [${exemption.current_lifecycle}; awaiting ${exemption.action_kind}] ${exemption.reason}`);
  }
  return lines.join("\n");
}
