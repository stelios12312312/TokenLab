// claim_briefing_compiler.mjs - compile work-orders and pack rubrics into closed-question briefings.

import { existsSync, readFileSync } from "fs";
import { join, relative, resolve } from "path";
import {
  PACK_CONTRACT_FILENAME,
  defaultPacksDir,
  defaultRootDir,
  validatePackContractFile,
} from "./pack_contract.mjs";
import { validateWorkOrder } from "./work_order_contract.mjs";

export const CLAIM_BRIEFING_SCHEMA_VERSION = 1;
export const CLAIM_BRIEFING_RETURN_TYPE = "claim_briefing";

const QUESTION_ANSWER_CONTRACT_TYPES = new Set([
  "run_command",
  "cite_line",
  "compare_value",
  "allowed_answer",
]);
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const OPEN_QUESTION_PATTERNS = [
  /\bexplain\b/i,
  /\bdescribe\b/i,
  /\bdiscuss\b/i,
  /\bevaluate\b/i,
  /\bassess\b/i,
  /\bwhat do you think\b/i,
  /\bwhy\b/i,
  /\bhow should\b/i,
  /\bopinion\b/i,
];

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function addIssue(issues, code, path, message) {
  issues.push({ code, path, message });
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function sanitizeIdPart(value, fallback = "item") {
  const text = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return text || fallback;
}

function stableRelative(rootDir, path) {
  const rel = relative(rootDir, path).replace(/\\/g, "/");
  return rel && !rel.startsWith("..") ? rel : path.replace(/\\/g, "/");
}

function normalizedCommand(value) {
  if (Array.isArray(value)) return value.filter(isNonEmptyString).map((entry) => entry.trim());
  return isNonEmptyString(value) ? value.trim() : "";
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function failure(errors, warnings = []) {
  return { ok: false, status: "FAIL", errors, warnings, briefing: null };
}

function success(briefing, warnings = []) {
  return { ok: true, status: "PASS", errors: [], warnings, briefing };
}

function normalizeInputRefs(workOrder) {
  return (Array.isArray(workOrder?.inputs) ? workOrder.inputs : []).map((input, index) => ({
    id: String(input?.id || `input_${index + 1}`).trim(),
    kind: isNonEmptyString(input?.kind) ? input.kind.trim() : "artifact",
    ref: String(input?.ref || "").trim(),
    description: isNonEmptyString(input?.description) ? input.description.trim() : null,
  }));
}

function contextIdsForClaim(contextRefs) {
  return contextRefs.map((entry) => `input:${entry.id}`);
}

function answerContractForProof(obligation) {
  if (obligation.method === "executed") {
    return {
      type: "run_command",
      command: normalizedCommand(obligation.command || obligation.command_or_action),
      pass_signal: "exit_code_0",
    };
  }
  if (obligation.method === "deterministic") {
    return {
      type: "compare_value",
      expected: "pass",
      check: String(obligation.check || obligation.predicate || "").trim(),
    };
  }
  return {
    type: "allowed_answer",
    allowed_answers: ["pass", "fail"],
    rubric_ref: String(obligation.rubric_ref || obligation.rubric || "").trim(),
  };
}

function questionForProofObligation({ obligation, claim, index, contextIds }) {
  const method = String(obligation.method || "").trim();
  const id = `q_${sanitizeIdPart(claim.id)}_${sanitizeIdPart(method)}_${index + 1}`;
  let question = `Does the ${method} proof obligation for claim '${claim.id}' pass?`;
  if (method === "executed") {
    question = `Did the required command for claim '${claim.id}' complete successfully with exit code 0?`;
  } else if (method === "deterministic") {
    question = `Does the deterministic check for claim '${claim.id}' pass?`;
  } else if (method === "rubric") {
    const rubricRef = String(obligation.rubric_ref || obligation.rubric || "declared rubric").trim();
    question = `Does rubric '${rubricRef}' pass for claim '${claim.id}'?`;
  }
  return {
    id,
    claim_id: claim.id,
    source_type: "proof_obligation",
    method,
    question,
    closed_question: true,
    allowed_answers: ["pass", "fail"],
    answer_contract: answerContractForProof(obligation),
    context_refs: contextIds,
  };
}

function questionForPackRubric({ claim, pack, rubric, contextIds }) {
  return {
    id: `q_${sanitizeIdPart(claim.id)}_${sanitizeIdPart(pack.pack_id)}_${sanitizeIdPart(rubric.id)}`,
    claim_id: claim.id,
    source_type: "pack_rubric",
    pack_id: pack.pack_id,
    rubric_id: rubric.id,
    question: String(rubric.question || "").trim(),
    closed_question: true,
    allowed_answers: unique(rubric.allowed_answers),
    answer_contract: {
      type: "allowed_answer",
      pack_id: pack.pack_id,
      rubric_id: rubric.id,
      evidence_required: ["answer", "evidence_ref"],
    },
    context_refs: contextIds,
  };
}

function normalizePackContract(entry) {
  const contract = entry?.contract || entry;
  return {
    pack_id: String(contract?.pack_id || entry?.pack_id || "").trim(),
    contract_ref: entry?.contract_ref || entry?.contract_path || null,
    rubrics: Array.isArray(contract?.rubrics) ? contract.rubrics : [],
  };
}

function validatePackInputs(packContracts, errors) {
  if (!Array.isArray(packContracts) || packContracts.length === 0) {
    addIssue(errors, "pack_contracts_empty", "pack_contracts", "At least one pack contract is required");
    return [];
  }

  const seen = new Set();
  const normalized = [];
  packContracts.forEach((entry, index) => {
    const pack = normalizePackContract(entry);
    const base = `pack_contracts[${index}]`;
    if (!isNonEmptyString(pack.pack_id)) {
      addIssue(errors, "pack_id_missing", `${base}.pack_id`, "pack contract requires pack_id");
      return;
    }
    if (seen.has(pack.pack_id)) {
      addIssue(errors, "duplicate_pack_id", `${base}.pack_id`, `Duplicate pack id '${pack.pack_id}'`);
      return;
    }
    seen.add(pack.pack_id);
    if (!Array.isArray(pack.rubrics) || pack.rubrics.length === 0) {
      addIssue(errors, "pack_rubrics_empty", `${base}.rubrics`, `pack '${pack.pack_id}' has no rubrics`);
      return;
    }
    pack.rubrics.forEach((rubric, rubricIndex) => {
      const rubricBase = `${base}.rubrics[${rubricIndex}]`;
      if (!isNonEmptyString(rubric?.id)) addIssue(errors, "rubric_id_missing", `${rubricBase}.id`, "rubric requires id");
      if (!isNonEmptyString(rubric?.question)) addIssue(errors, "rubric_question_missing", `${rubricBase}.question`, "rubric requires question");
      if (rubric?.closed_question !== true) addIssue(errors, "rubric_not_closed", `${rubricBase}.closed_question`, "rubric must be closed_question=true");
      if (!Array.isArray(rubric?.allowed_answers) || rubric.allowed_answers.length < 2) {
        addIssue(errors, "rubric_allowed_answers_invalid", `${rubricBase}.allowed_answers`, "rubric requires at least two allowed answers");
      }
    });
    normalized.push(pack);
  });
  return normalized.sort((a, b) => a.pack_id.localeCompare(b.pack_id));
}

export function compileClaimBriefing({
  workOrder,
  packContracts = [],
  source = {},
} = {}) {
  const errors = [];
  const warnings = [];
  const workOrderValidation = validateWorkOrder(workOrder);
  if (!workOrderValidation.ok) {
    for (const error of workOrderValidation.errors || []) {
      errors.push({ ...error, source: "work_order" });
    }
    return failure(errors, warnings);
  }

  const packs = validatePackInputs(packContracts, errors);
  if (errors.length > 0) return failure(errors, warnings);

  const contextRefs = normalizeInputRefs(workOrder);
  const contextIds = contextIdsForClaim(contextRefs);
  const proofObligations = Array.isArray(workOrder.proof_obligations) ? workOrder.proof_obligations : [];
  const proofByClaim = new Map();
  proofObligations.forEach((obligation) => {
    const entries = proofByClaim.get(obligation.claim_id) || [];
    entries.push(obligation);
    proofByClaim.set(obligation.claim_id, entries);
  });

  const briefingPacks = packs.map((pack) => ({
    pack_id: pack.pack_id,
    contract_ref: pack.contract_ref,
    rubric_count: pack.rubrics.length,
    rubric_ids: pack.rubrics.map((rubric) => rubric.id).sort(),
  }));

  const claims = workOrder.claims_to_produce.map((claim) => {
    const questions = [];
    const obligations = proofByClaim.get(claim.id) || [];
    obligations.forEach((obligation, index) => {
      questions.push(questionForProofObligation({ obligation, claim, index, contextIds }));
    });
    for (const pack of packs) {
      for (const rubric of pack.rubrics) {
        questions.push(questionForPackRubric({ claim, pack, rubric, contextIds }));
      }
    }
    return {
      id: claim.id,
      statement: claim.statement,
      consumer: isNonEmptyString(claim.consumer) ? claim.consumer : null,
      context_refs: contextIds,
      questions,
    };
  });

  const questionCount = claims.reduce((sum, claim) => sum + claim.questions.length, 0);
  const proofQuestionCount = claims.reduce(
    (sum, claim) => sum + claim.questions.filter((question) => question.source_type === "proof_obligation").length,
    0,
  );
  const packQuestionCount = claims.reduce(
    (sum, claim) => sum + claim.questions.filter((question) => question.source_type === "pack_rubric").length,
    0,
  );

  const briefing = {
    schema_version: CLAIM_BRIEFING_SCHEMA_VERSION,
    return_type: CLAIM_BRIEFING_RETURN_TYPE,
    work_order: {
      id: workOrder.id || null,
      goal: workOrder.goal,
      budget: workOrder.budget,
    },
    source: {
      compiler: "claim_briefing_compiler",
      work_order_ref: source.work_order_ref || null,
      selected_pack_ids: briefingPacks.map((pack) => pack.pack_id),
    },
    context_refs: contextRefs,
    packs: briefingPacks,
    claims,
    summary: {
      pack_count: briefingPacks.length,
      claim_count: claims.length,
      question_count: questionCount,
      proof_obligation_question_count: proofQuestionCount,
      pack_rubric_question_count: packQuestionCount,
      context_ref_count: contextRefs.length,
    },
  };

  const validation = validateClaimBriefing(briefing);
  if (!validation.ok) return { ...validation, briefing };
  return success(briefing, warnings);
}

function loadSelectedPackContracts({ packIds = [], packsDir = defaultPacksDir(), rootDir = defaultRootDir() } = {}) {
  const resolvedPacksDir = resolve(packsDir);
  const resolvedRootDir = resolve(rootDir);
  const errors = [];
  const selected = unique(packIds).sort();

  if (selected.length === 0) {
    addIssue(errors, "pack_selection_empty", "pack_ids", "At least one pack id must be selected for claim briefing compilation");
    return { ok: false, errors, packContracts: [] };
  }

  const packContracts = [];
  for (const packId of selected) {
    const packDir = join(resolvedPacksDir, packId);
    const contractPath = join(packDir, PACK_CONTRACT_FILENAME);
    if (!existsSync(contractPath)) {
      addIssue(errors, "pack_contract_missing", `pack_ids.${packId}`, `Pack '${packId}' does not have ${PACK_CONTRACT_FILENAME}`);
      continue;
    }
    const validation = validatePackContractFile(contractPath, { packDir, rootDir: resolvedRootDir });
    if (!validation.ok) {
      for (const error of validation.errors || []) {
        errors.push({ ...error, pack_id: packId, source: "pack_contract" });
      }
      continue;
    }
    packContracts.push({
      contract: readJsonFile(contractPath),
      contract_path: stableRelative(resolvedRootDir, contractPath),
      pack_id: packId,
    });
  }

  return { ok: errors.length === 0, errors, packContracts };
}

export function compileClaimBriefingFromFiles({
  workOrderPath,
  packIds = [],
  packsDir = defaultPacksDir(),
  rootDir = defaultRootDir(),
} = {}) {
  const errors = [];
  const warnings = [];
  if (!isNonEmptyString(workOrderPath)) {
    addIssue(errors, "work_order_path_missing", "work_order_path", "workOrderPath is required");
    return failure(errors, warnings);
  }

  const resolvedWorkOrderPath = resolve(workOrderPath);
  if (!existsSync(resolvedWorkOrderPath)) {
    addIssue(errors, "work_order_file_missing", "work_order_path", `Work-order file '${resolvedWorkOrderPath}' does not exist`);
    return failure(errors, warnings);
  }

  let workOrder;
  try {
    workOrder = readJsonFile(resolvedWorkOrderPath);
  } catch (error) {
    addIssue(errors, "work_order_read_failed", "work_order_path", error.message);
    return failure(errors, warnings);
  }

  const packResult = loadSelectedPackContracts({ packIds, packsDir, rootDir });
  if (!packResult.ok) return failure(packResult.errors, warnings);

  const result = compileClaimBriefing({
    workOrder,
    packContracts: packResult.packContracts,
    source: {
      work_order_ref: stableRelative(resolve(rootDir), resolvedWorkOrderPath),
    },
  });
  return result;
}

function validateId(value, path, label, errors) {
  if (!isNonEmptyString(value)) {
    addIssue(errors, `${label}_id_missing`, path, `${label} id must be non-empty`);
    return false;
  }
  if (!ID_PATTERN.test(value)) {
    addIssue(errors, `${label}_id_invalid`, path, `${label} id must match ${ID_PATTERN}`);
    return false;
  }
  return true;
}

function validateStringArray(value, path, label, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    addIssue(errors, `${label}_empty`, path, `${label} must be a non-empty array`);
    return;
  }
  value.forEach((entry, index) => {
    if (!isNonEmptyString(entry)) {
      addIssue(errors, `${label}_entry_invalid`, `${path}[${index}]`, `${label} entries must be non-empty strings`);
    }
  });
}

function containsOpenQuestionPattern(question) {
  return OPEN_QUESTION_PATTERNS.some((pattern) => pattern.test(String(question || "")));
}

function validateQuestion(question, path, claimIds, questionIds, errors) {
  if (!isPlainObject(question)) {
    addIssue(errors, "question_not_object", path, "questions entries must be objects");
    return;
  }
  if (validateId(question.id, `${path}.id`, "question", errors)) {
    if (questionIds.has(question.id)) {
      addIssue(errors, "duplicate_question_id", `${path}.id`, `Duplicate question id '${question.id}'`);
    } else {
      questionIds.add(question.id);
    }
  }
  if (!isNonEmptyString(question.claim_id)) {
    addIssue(errors, "question_claim_id_missing", `${path}.claim_id`, "question must name claim_id");
  } else if (!claimIds.has(question.claim_id)) {
    addIssue(errors, "question_orphan_claim", `${path}.claim_id`, `question references unknown claim_id '${question.claim_id}'`);
  }
  if (!isNonEmptyString(question.question)) {
    addIssue(errors, "question_text_missing", `${path}.question`, "question must be non-empty");
  } else if (containsOpenQuestionPattern(question.question)) {
    addIssue(errors, "question_open_ended", `${path}.question`, "question uses open-ended wording; use a closed yes/no/pass/fail question");
  }
  if (question.closed_question !== true) {
    addIssue(errors, "question_not_closed", `${path}.closed_question`, "question must declare closed_question=true");
  }
  if (!Array.isArray(question.allowed_answers) || question.allowed_answers.length < 2) {
    addIssue(
      errors,
      "question_allowed_answers_invalid",
      `${path}.allowed_answers`,
      "question.allowed_answers must contain at least two non-empty answers",
    );
  } else {
    validateStringArray(question.allowed_answers, `${path}.allowed_answers`, "question_allowed_answers", errors);
  }
  if (isPlainObject(question.answer_contract)) {
    if (!QUESTION_ANSWER_CONTRACT_TYPES.has(question.answer_contract.type)) {
      addIssue(
        errors,
        "answer_contract_type_invalid",
        `${path}.answer_contract.type`,
        `answer_contract.type must be one of ${[...QUESTION_ANSWER_CONTRACT_TYPES].join(", ")}`,
      );
    }
  } else {
    addIssue(errors, "answer_contract_missing", `${path}.answer_contract`, "question must include an answer_contract object");
  }
  validateStringArray(question.context_refs, `${path}.context_refs`, "question_context_refs", errors);
}

export function validateClaimBriefing(payload) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(payload)) {
    addIssue(errors, "claim_briefing_not_object", "$", "Claim briefing must be a JSON object");
    return { ok: false, status: "FAIL", errors, warnings };
  }
  if (payload.schema_version !== CLAIM_BRIEFING_SCHEMA_VERSION) {
    addIssue(errors, "schema_version_invalid", "schema_version", `schema_version must be ${CLAIM_BRIEFING_SCHEMA_VERSION}`);
  }
  if (payload.return_type !== CLAIM_BRIEFING_RETURN_TYPE) {
    addIssue(errors, "return_type_invalid", "return_type", `return_type must be '${CLAIM_BRIEFING_RETURN_TYPE}'`);
  }
  if (!isPlainObject(payload.work_order)) {
    addIssue(errors, "work_order_summary_missing", "work_order", "work_order summary must be an object");
  } else {
    if (!isNonEmptyString(payload.work_order.goal)) {
      addIssue(errors, "work_order_goal_missing", "work_order.goal", "work_order goal must be non-empty");
    }
    if (!isPlainObject(payload.work_order.budget)) {
      addIssue(errors, "work_order_budget_missing", "work_order.budget", "work_order budget must be present");
    }
  }
  if (!Array.isArray(payload.context_refs) || payload.context_refs.length === 0) {
    addIssue(errors, "context_refs_empty", "context_refs", "context_refs must include focused source refs");
  }
  if (!Array.isArray(payload.packs) || payload.packs.length === 0) {
    addIssue(errors, "packs_empty", "packs", "packs must include at least one selected pack");
  }

  const claimIds = new Set();
  const questionIds = new Set();
  if (!Array.isArray(payload.claims) || payload.claims.length === 0) {
    addIssue(errors, "claims_empty", "claims", "claims must be a non-empty array");
  } else {
    payload.claims.forEach((claim, index) => {
      const path = `claims[${index}]`;
      if (!isPlainObject(claim)) {
        addIssue(errors, "claim_not_object", path, "claims entries must be objects");
        return;
      }
      if (validateId(claim.id, `${path}.id`, "claim", errors)) {
        if (claimIds.has(claim.id)) {
          addIssue(errors, "duplicate_claim_id", `${path}.id`, `Duplicate claim id '${claim.id}'`);
        } else {
          claimIds.add(claim.id);
        }
      }
      if (!isNonEmptyString(claim.statement)) {
        addIssue(errors, "claim_statement_missing", `${path}.statement`, "claim statement must be non-empty");
      }
      validateStringArray(claim.context_refs, `${path}.context_refs`, "claim_context_refs", errors);
      if (!Array.isArray(claim.questions) || claim.questions.length === 0) {
        addIssue(errors, "claim_questions_empty", `${path}.questions`, "each claim must include closed questions");
      }
    });

    payload.claims.forEach((claim, claimIndex) => {
      if (!isPlainObject(claim) || !Array.isArray(claim.questions)) return;
      claim.questions.forEach((question, questionIndex) => {
        validateQuestion(question, `claims[${claimIndex}].questions[${questionIndex}]`, claimIds, questionIds, errors);
      });
    });
  }

  if (isPlainObject(payload.summary)) {
    const actualQuestionCount = Array.isArray(payload.claims)
      ? payload.claims.reduce((sum, claim) => sum + (Array.isArray(claim?.questions) ? claim.questions.length : 0), 0)
      : 0;
    if (payload.summary.question_count !== actualQuestionCount) {
      addIssue(errors, "summary_question_count_mismatch", "summary.question_count", "summary.question_count must equal actual question count");
    }
    if (Array.isArray(payload.claims) && payload.summary.claim_count !== payload.claims.length) {
      addIssue(errors, "summary_claim_count_mismatch", "summary.claim_count", "summary.claim_count must equal claims.length");
    }
  } else {
    addIssue(errors, "summary_missing", "summary", "summary must be an object with deterministic counts");
  }

  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? "PASS" : "FAIL",
    errors,
    warnings,
  };
}

export function renderClaimBriefingMarkdown(briefing) {
  const lines = [
    "# Claim Briefing",
    "",
    `Return type: ${briefing.return_type}`,
    `Work order: ${briefing.work_order?.id || "(unnamed)"}`,
    `Claims: ${briefing.summary?.claim_count ?? 0}`,
    `Questions: ${briefing.summary?.question_count ?? 0}`,
    "",
    "## Packs",
  ];

  for (const pack of Array.isArray(briefing.packs) ? briefing.packs : []) {
    lines.push(`- ${pack.pack_id}: ${pack.rubric_count} rubrics`);
  }

  lines.push("", "## Questions");
  for (const claim of Array.isArray(briefing.claims) ? briefing.claims : []) {
    lines.push("", `### ${claim.id}`, claim.statement || "");
    for (const question of Array.isArray(claim.questions) ? claim.questions : []) {
      lines.push(`- [${question.id}] ${question.question} (${question.allowed_answers.join("/")})`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
