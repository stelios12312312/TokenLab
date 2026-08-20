// Deterministic parent-side grader for production autonomous ticket delivery.
// @planner:module = task_rubric_grader
// @planner:capability = production_autonomous_ticket_parent_grade
// @planner:proves = crit:sc_1, crit:sc_2, crit:sc_3

import { createHash } from "crypto";

export const TASK_RUBRIC_GRADE_SCHEMA = "ive.task_rubric_grade.v1";

const TERMINAL_PLAN_STATES = new Set(["close", "closed"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value) {
  return String(value || "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function pathAllowed(path, allowedPaths) {
  const normalized = clean(path).replaceAll("\\", "/");
  return allowedPaths.some((entry) => {
    const allowed = clean(entry).replaceAll("\\", "/");
    if (!allowed) return false;
    return allowed.endsWith("/") ? normalized.startsWith(allowed) : normalized === allowed;
  });
}

function failure(code, detail, extra = {}) {
  return { code, detail, ...extra };
}

export function gradeTaskArtifact(artifact = {}) {
  const failures = [];
  const finalCommit = clean(artifact.final_commit);
  const baseCommit = clean(artifact.base_commit);
  const reachableCommits = new Set(asArray(artifact.reachable_commits).map(clean));
  const changedPaths = [...new Set(asArray(artifact.changed_paths).map(clean).filter(Boolean))].sort();
  const allowedPaths = [...new Set(asArray(artifact.allowed_paths).map(clean).filter(Boolean))].sort();
  const usage = artifact.usage && typeof artifact.usage === "object" ? artifact.usage : null;
  const totalTokens = Number(usage?.total_tokens);
  const maxTotalTokens = Number(artifact.limits?.max_total_tokens);
  const diffLines = Number(artifact.diff_lines);
  const maxDiffLines = Number(artifact.limits?.max_diff_lines);
  const maxChangedFiles = Number(artifact.limits?.max_changed_files);

  if (artifact.invocation_count !== 1) {
    failures.push(failure("agent_invocation_count", `expected exactly one invocation, received ${artifact.invocation_count ?? 0}`));
  }
  if (artifact.timed_out === true) failures.push(failure("agent_timeout", "agent command exceeded the configured timeout"));
  if (artifact.agent_exit_code !== 0) failures.push(failure("agent_command_failed", `agent command exited ${artifact.agent_exit_code ?? "unknown"}`));
  if (!usage || !Number.isFinite(totalTokens)) failures.push(failure("usage_unavailable", "agent token usage is required for a budgeted production run"));
  if (Number.isFinite(maxTotalTokens) && Number.isFinite(totalTokens) && totalTokens > maxTotalTokens) {
    failures.push(failure("budget_exhausted", `token usage ${totalTokens} exceeds ${maxTotalTokens}`, { used_tokens: totalTokens, max_tokens: maxTotalTokens }));
  }
  if (!/^[0-9a-f]{40}$/i.test(finalCommit) || !reachableCommits.has(finalCommit)) {
    failures.push(failure("fabricated_ref", "final commit is absent, malformed, or not reachable from the candidate repository"));
  }
  if (finalCommit && finalCommit === baseCommit) failures.push(failure("no_candidate_commit", "candidate HEAD did not advance from the pinned base"));
  if (artifact.worktree_clean !== undefined && artifact.worktree_clean !== true) {
    failures.push(failure("uncommitted_candidate_changes", "candidate worktree contains uncommitted changes"));
  }
  if (JSON.stringify(stable(artifact.immutable_inputs?.before || {})) !== JSON.stringify(stable(artifact.immutable_inputs?.after || {}))) {
    failures.push(failure("proof_tampered", "candidate changed a parent-owned grader, test, or immutable proof input"));
  }
  for (const path of changedPaths) {
    if (!pathAllowed(path, allowedPaths)) failures.push(failure("unexpected_worktree_path", path, { path }));
  }
  if (Number.isFinite(maxChangedFiles) && changedPaths.length > maxChangedFiles) {
    failures.push(failure("changed_file_budget_exhausted", `${changedPaths.length} changed files exceeds ${maxChangedFiles}`));
  }
  if (Number.isFinite(maxDiffLines) && Number.isFinite(diffLines) && diffLines > maxDiffLines) {
    failures.push(failure("diff_line_budget_exhausted", `${diffLines} diff lines exceeds ${maxDiffLines}`));
  }
  if (artifact.tests?.exit_code !== 0 || lower(artifact.tests?.status) !== "pass") {
    failures.push(failure("final_tests_not_green", `parent verification status=${artifact.tests?.status || "missing"} exit=${artifact.tests?.exit_code ?? "missing"}`));
  }
  if (lower(artifact.target?.lifecycle) !== "closed") {
    failures.push(failure("target_not_closed", `target lifecycle is ${artifact.target?.lifecycle || "missing"}`));
  }
  if (!TERMINAL_PLAN_STATES.has(lower(artifact.target?.child_plan_state))) {
    failures.push(failure("child_plan_not_closed", `child plan state is ${artifact.target?.child_plan_state || "missing"}`));
  }
  if (asArray(artifact.evidence_refs).length === 0) failures.push(failure("evidence_missing", "parent grade requires persisted evidence references"));

  const gradeInput = {
    ticket_id: clean(artifact.ticket_id),
    base_commit: baseCommit,
    final_commit: finalCommit,
    changed_paths: changedPaths,
    immutable_inputs: stable(artifact.immutable_inputs || {}),
    invocation_count: artifact.invocation_count ?? null,
    agent_exit_code: artifact.agent_exit_code ?? null,
    timed_out: artifact.timed_out === true,
    tests: stable(artifact.tests || {}),
    target: stable(artifact.target || {}),
    usage: stable(usage || {}),
    evidence_refs: [...new Set(asArray(artifact.evidence_refs).map(clean).filter(Boolean))].sort(),
    diff_lines: Number.isFinite(diffLines) ? diffLines : null,
    limits: stable(artifact.limits || {}),
  };
  return {
    schema_version: TASK_RUBRIC_GRADE_SCHEMA,
    status: failures.length === 0 ? "PASS" : "FAIL",
    ok: failures.length === 0,
    score: failures.length === 0 ? 1 : 0,
    failures,
    grade_input_sha256: digest(gradeInput),
    transcript_used_for_outcome: false,
    ignored_candidate_metadata: ["arm_id", "executor", "provider", "model", "task_success", "self_reported_status", "transcript"],
  };
}
function expectedReplaySuccess(expected = {}) {
  const routeStatus = lower(expected.route_status);
  if (!routeStatus || ["blocked", "unrouted"].includes(routeStatus)) return false;
  if (!clean(expected.valid_next_action)) return false;
  if (expected.quant_guard_required && expected.promotion_allowed !== false) return false;
  if (expected.non_claims_required && expected.promotion_allowed !== false) return false;
  return true;
}

export function gradeProxyBenchmark(benchmark = {}) {
  const rows = asArray(benchmark.tasks).slice(0, 10).map((task) => {
    const derived = expectedReplaySuccess(task.expected_outcome);
    const anchorArm = asArray(task.arms).find((arm) => clean(arm?.arm_id) === "planner_wrapped") || null;
    const selfReported = typeof anchorArm?.task_success === "boolean" ? anchorArm.task_success : null;
    return {
      task_id: clean(task.task_id),
      derived_task_success: derived,
      committed_anchor: selfReported,
      anchor_match: selfReported === derived,
    };
  });
  return {
    schema_version: "ive.task_rubric_proxy_regression.v1",
    task_count: rows.length,
    anchor_matches: rows.filter((row) => row.anchor_match).length,
    self_report_divergence_count: rows.filter((row) => !row.anchor_match).length,
    rows,
    grade_source: "expected_outcome_fields",
  };
}
