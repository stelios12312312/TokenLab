import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { callSidekickProvider } from "./sidekick_providers.mjs";

const COMMIT_HEADER = /^(feat|fix|docs|test|refactor|chore|perf|ci|build|style|revert)(\([A-Za-z0-9._-]+\))?: .{1,72}$/;

export function buildCommitMessagePrompt(diffText) {
  return [
    "Generate a concise conventional commit message for this staged diff.",
    "",
    "Output only the commit message. No markdown fence. No commentary.",
    "Format:",
    "type(scope): short imperative subject",
    "",
    "Why",
    "- One bullet explaining why the change exists",
    "",
    "What",
    "- One or two bullets explaining what changed",
    "",
    "Proof",
    "- One bullet naming the verification evidence, or 'Not run' if absent",
    "",
    "Diff:",
    String(diffText || "").slice(0, 20000),
  ].join("\n");
}

export function validateCommitMessage(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return { ok: false, reason: "empty_output" };
  if (/```/.test(text)) return { ok: false, reason: "markdown_fence_not_allowed" };
  const lines = text.split(/\r?\n/);
  if (!COMMIT_HEADER.test(lines[0] || "")) return { ok: false, reason: "invalid_conventional_header" };
  for (const section of ["Why", "What", "Proof"]) {
    if (!lines.some((line) => line.trim() === section)) return { ok: false, reason: `missing_${section.toLowerCase()}_section` };
  }
  return { ok: true, message: `${text}\n` };
}

export function fallbackText(prompt, reason) {
  return [
    "Sidekick could not produce a valid commit message.",
    `Reason: ${reason}`,
    "",
    "Driving agent: please generate this.",
    "",
    "Prompt:",
    prompt,
  ].join("\n");
}

export function readStagedDiff(cwd = process.cwd()) {
  return execFileSync("git", ["diff", "--cached"], { cwd, encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 });
}

export function appendSidekickAudit(cwd, event, now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  const logPath = join(cwd, "reports", "sidekick", `${date}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify({ ...event, timestamp: now.toISOString(), retention: "permanent", retention_class: 4 })}\n`);
  return logPath;
}

export async function generateCommitMessage({ cwd = process.cwd(), diffText, config, now = new Date() }) {
  const prompt = buildCommitMessagePrompt(diffText);
  const baseEvent = {
    command: "sidekick.commit-message",
    provider: config.provider,
    provider_type: config.type,
    model: config.model,
    input_bytes: Buffer.byteLength(String(diffText || ""), "utf-8"),
    prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
  };

  try {
    const providerResult = await callSidekickProvider(config, prompt);
    const validation = validateCommitMessage(providerResult.text);
    if (!validation.ok) {
      appendSidekickAudit(cwd, {
        ...baseEvent,
        status: "fallback",
        fallback: true,
        output_bytes: Buffer.byteLength(String(providerResult.text || ""), "utf-8"),
        validation_error: validation.reason,
      }, now);
      return { ok: false, text: fallbackText(prompt, validation.reason), reason: validation.reason };
    }
    appendSidekickAudit(cwd, {
      ...baseEvent,
      status: "success",
      fallback: false,
      output_bytes: Buffer.byteLength(validation.message, "utf-8"),
    }, now);
    return { ok: true, text: validation.message };
  } catch (error) {
    const reason = error?.message || "provider_error";
    appendSidekickAudit(cwd, {
      ...baseEvent,
      status: "fallback",
      fallback: true,
      output_bytes: 0,
      error: reason,
    }, now);
    return { ok: false, text: fallbackText(prompt, reason), reason };
  }
}
