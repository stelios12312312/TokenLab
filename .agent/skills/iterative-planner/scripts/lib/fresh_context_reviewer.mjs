import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  redactSecrets,
} from "./provider_client.mjs";
import {
  callRoleProviderJson,
  createCostLedger,
  publicRoleProviderConfig,
  resolveRoleProvider,
} from "./role_provider_runtime.mjs";
import {
  normalizeVerificationStatus,
  verificationStatusIsPass,
} from "./verification_status_vocabulary.mjs";

const __filename = fileURLToPath(import.meta.url);
const LIB_DIR = dirname(__filename);
const SKILL_DIR = resolve(LIB_DIR, "..", "..");
const REPO_ROOT = resolve(SKILL_DIR, "..", "..", "..");
const DEFAULT_CONFIG_PATH = join(REPO_ROOT, ".github", "reviewer", "config.json");
const VALID_ANSWERS = new Set(["yes", "no", "uncertain"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function splitChangedFiles(value) {
  if (Array.isArray(value)) return value.map(cleanString).filter(Boolean);
  return String(value || "")
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function escapeRegex(value) {
  return String(value).replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern) {
  const raw = String(pattern || "").trim();
  if (!raw) return /^$/;
  const placeholder = "\u0000GLOBSTAR\u0000";
  const escaped = escapeRegex(raw.split("**").join(placeholder))
    .split(placeholder).join(".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function matchesPath(filePath, patterns) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  return asArray(patterns).some((pattern) => globToRegex(pattern).test(normalized));
}

export function loadReviewerConfig({ configPath = DEFAULT_CONFIG_PATH } = {}) {
  const resolved = resolve(configPath);
  if (!existsSync(resolved)) {
    throw Object.assign(new Error(`Reviewer config not found: ${resolved}`), { code: "config_missing" });
  }
  const config = readJson(resolved);
  if (config?.schema_version !== 1) {
    throw Object.assign(new Error("Reviewer config must declare schema_version 1"), { code: "config_invalid" });
  }
  if (config.fail_honest !== true) {
    throw Object.assign(new Error("Reviewer config must set fail_honest=true"), { code: "config_invalid" });
  }
  return {
    ...config,
    path: resolved,
    packs: asArray(config.packs).map(cleanString).filter(Boolean),
    self_review_paths: asArray(config.self_review_paths).map(cleanString).filter(Boolean),
  };
}

async function loadPack(packId) {
  const packPath = join(SKILL_DIR, "packs", packId, "index.mjs");
  if (!existsSync(packPath)) {
    throw Object.assign(new Error(`Reviewer pack not found: ${packId}`), { code: "pack_missing", pack_id: packId });
  }
  const mod = await import(pathToFileURL(packPath).href);
  const pack = mod.default || mod;
  if (!pack || typeof pack.rules !== "function") {
    throw Object.assign(new Error(`Reviewer pack has no rules() method: ${packId}`), { code: "pack_invalid", pack_id: packId });
  }
  return pack;
}

export async function buildReviewerRubric({ configPath = DEFAULT_CONFIG_PATH } = {}) {
  const config = loadReviewerConfig({ configPath });
  const questions = [];
  for (const packId of config.packs) {
    const pack = await loadPack(packId);
    for (const rule of asArray(pack.rules())) {
      const ruleId = cleanString(rule?.id);
      const name = cleanString(rule?.name);
      if (!ruleId || !name) continue;
      questions.push({
        id: `${packId}:${ruleId}`,
        pack_id: packId,
        rule_id: ruleId,
        rule_name: name,
        answer_type: "yes_no_uncertain",
        question: `Does the PR diff introduce or preserve a ${ruleId} violation (${name})? Answer only yes, no, or uncertain.`,
        rationale: cleanString(rule?.rationale),
        false_positive: cleanString(rule?.false_positive),
        remediation: cleanString(rule?.remediation),
        engine: cleanString(rule?.engine),
      });
    }
  }
  return {
    schema_version: 1,
    config_path: relative(REPO_ROOT, config.path),
    packs: config.packs,
    question_count: questions.length,
    questions,
  };
}

function buildMessages({ diffText, changedFiles, rubric }) {
  const diffExcerpt = String(diffText || "").slice(0, 60000);
  return [
    {
      role: "system",
      content: [
        "You are a fresh-context pull request reviewer.",
        "You must use only the supplied diff, changed file list, and closed questions.",
        "Do not infer author intent from any conversation or hidden context.",
        "Return one JSON object with: status pass|fail|uncertain, summary, answers[].",
        "Each answer must include rule_id and answer yes|no|uncertain; yes means the diff violates that rule.",
      ].join(" "),
    },
    {
      role: "user",
      content: JSON.stringify({
        changed_files: changedFiles,
        closed_questions: rubric.questions.map((question) => ({
          pack_id: question.pack_id,
          rule_id: question.rule_id,
          rule_name: question.rule_name,
          answer_type: question.answer_type,
          question: question.question,
          rationale: question.rationale,
          false_positive: question.false_positive,
          remediation: question.remediation,
        })),
        diff: diffExcerpt,
      }),
    },
  ];
}

function normalizeAnswer(raw, index) {
  const answer = String(raw?.answer || raw?.verdict || "").trim().toLowerCase();
  return {
    rule_id: cleanString(raw?.rule_id || raw?.ruleId),
    answer: VALID_ANSWERS.has(answer) ? answer : "uncertain",
    finding_id: cleanString(raw?.finding_id || raw?.id) || `reviewer-finding-${index + 1}`,
    finding: cleanString(raw?.finding || raw?.reason || raw?.summary),
    evidence: cleanString(raw?.evidence),
  };
}

function normalizeProviderPayload(payload, rubric) {
  const rawStatus = normalizeVerificationStatus(payload?.status || payload?.verdict, "execution");
  const answers = asArray(payload?.answers).map(normalizeAnswer);
  const answerStatus = answers.length === 0
    ? "uncertain"
    : answers.some((answer) => answer.answer === "yes")
      ? "fail"
      : answers.some((answer) => answer.answer === "uncertain")
        ? "uncertain"
        : "pass";
  const status = rawStatus.valid
    ? rawStatus.kind === "pass"
      ? "pass"
      : rawStatus.kind === "fail"
        ? "fail"
        : "uncertain"
    : answerStatus;
  const byRule = new Map(rubric.questions.map((question) => [question.rule_id, question]));
  const answerFindings = answers
    .filter((answer) => answer.answer === "yes")
    .map((answer) => {
      const question = byRule.get(answer.rule_id);
      return {
        id: answer.finding_id,
        rule_id: answer.rule_id,
        pack_id: question?.pack_id || null,
        summary: answer.finding || `Reviewer answered yes for ${answer.rule_id}`,
        evidence: answer.evidence || null,
      };
    });
  const explicitFindings = asArray(payload?.findings).map((finding, index) => ({
    id: cleanString(finding?.id) || `provider-finding-${index + 1}`,
    rule_id: cleanString(finding?.rule_id || finding?.ruleId),
    pack_id: cleanString(finding?.pack_id) || null,
    summary: cleanString(finding?.summary || finding?.finding || finding?.reason),
    evidence: cleanString(finding?.evidence) || null,
  })).filter((finding) => finding.summary || finding.rule_id);
  const findings = [...answerFindings, ...explicitFindings];
  return {
    status: status === "uncertain" ? "fail" : status,
    reason: status === "uncertain" ? "escalation_required" : status,
    summary: cleanString(payload?.summary) || (verificationStatusIsPass(status, "execution") ? "No closed-question violations found." : "Reviewer found closed-question issues."),
    answers,
    findings,
  };
}

function selfReviewPaths(changedFiles, config) {
  return splitChangedFiles(changedFiles).filter((file) => matchesPath(file, config.self_review_paths));
}

function failVerdict({ reason, summary, changedFiles = [], rubric = null, details = {}, exitCode = 1 }) {
  return {
    schema_version: 1,
    status: "fail",
    reason,
    summary,
    fail_honest: true,
    fresh_context: true,
    changed_files: splitChangedFiles(changedFiles),
    question_count: rubric?.question_count || 0,
    packs: rubric?.packs || [],
    findings: [],
    exit_code: exitCode,
    ...details,
  };
}

export function renderReviewerComment(verdict, config = {}) {
  const heading = config?.comment?.heading || "Fresh-Context Reviewer";
  const lines = [
    `## ${heading}`,
    "",
    `Status: ${verdict.status || "fail"}`,
    `Reason: ${verdict.reason || "n/a"}`,
    `Summary: ${verdict.summary || "n/a"}`,
    `Fresh context: ${verdict.fresh_context === true ? "yes" : "no"}`,
    `Closed questions: ${verdict.question_count || 0}`,
  ];
  if (Array.isArray(verdict.changed_files) && verdict.changed_files.length > 0) {
    lines.push("", "### Changed Files");
    for (const file of verdict.changed_files.slice(0, 30)) lines.push(`- ${file}`);
  }
  if (Array.isArray(verdict.findings) && verdict.findings.length > 0) {
    lines.push("", "### Findings");
    for (const finding of verdict.findings) {
      lines.push(`- ${finding.id || finding.rule_id || "finding"}: ${finding.summary || "review finding"}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function readDiffFromGit({ base, head }) {
  if (!base || !head) {
    throw Object.assign(new Error("Either --diff-file or --base/--head is required"), { code: "diff_missing" });
  }
  return execFileSync("git", ["diff", "--no-ext-diff", "--unified=80", `${base}...${head}`], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readChangedFilesFromGit({ base, head }) {
  if (!base || !head) return [];
  const out = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return splitChangedFiles(out);
}

export async function reviewPullRequest({
  configPath = DEFAULT_CONFIG_PATH,
  diffFile = "",
  diffText = "",
  changedFiles = [],
  base = "",
  head = "",
  commentFile = "",
  env = process.env,
} = {}) {
  const config = loadReviewerConfig({ configPath });
  const rubric = await buildReviewerRubric({ configPath });
  const files = splitChangedFiles(changedFiles).length > 0 ? splitChangedFiles(changedFiles) : readChangedFilesFromGit({ base, head });
  const diff = diffText || (diffFile ? readFileSync(resolve(diffFile), "utf-8") : readDiffFromGit({ base, head }));
  const selfReview = selfReviewPaths(files, config);
  let verdict;

  if (selfReview.length > 0) {
    verdict = failVerdict({
      reason: "self_review_modification",
      summary: "PR modifies reviewer-owned configuration or wiring; fresh-context reviewer cannot self-approve this change.",
      changedFiles: files,
      rubric,
      details: { self_review_paths: selfReview },
      exitCode: 1,
    });
  } else {
    const ledger = createCostLedger({ taskId: "fresh_context_reviewer" });
    let provider = null;
    try {
      provider = resolveRoleProvider({ role: "reviewer", config, env });
      const response = await callRoleProviderJson({
        role: "reviewer",
        config,
        messages: buildMessages({ diffText: diff, changedFiles: files, rubric }),
        ledger,
        taskId: "fresh_context_reviewer",
        temperature: 0,
        maxTokens: 1400,
        env,
      });
      const normalized = normalizeProviderPayload(response.parsed, rubric);
      verdict = {
        schema_version: 1,
        status: normalized.status,
        reason: normalized.reason,
        summary: normalized.summary,
        fail_honest: true,
        fresh_context: true,
        changed_files: files,
        question_count: rubric.question_count,
        packs: rubric.packs,
        answers: normalized.answers,
        findings: normalized.findings,
        provider: { ...response.provider, source: response.source || "provider" },
        cost_ledger: response.cost_ledger || ledger.summary(),
        exit_code: verificationStatusIsPass(normalized.status, "execution") ? 0 : 1,
      };
    } catch (error) {
      const unavailable = error?.code === "unavailable" || error?.code === "provider_unavailable";
      verdict = failVerdict({
        reason: unavailable ? "provider_unavailable" : "provider_error",
        summary: unavailable
          ? `Reviewer provider unavailable: ${error?.message || "missing provider config"}`
          : `Reviewer provider error: ${redactSecrets(error?.message || "unknown provider error", env)}`,
        changedFiles: files,
        rubric,
        details: {
          provider: error?.provider || publicRoleProviderConfig(provider || resolveRoleProvider({ role: "reviewer", config, env })),
          cost_ledger: ledger.summary(),
          error_code: error?.code || "provider_error",
        },
        exitCode: 2,
      });
    }
  }

  if (commentFile) {
    writeFileSync(resolve(commentFile), renderReviewerComment(verdict, config));
  }
  return verdict;
}

export { DEFAULT_CONFIG_PATH as FRESH_CONTEXT_REVIEWER_CONFIG_PATH };
