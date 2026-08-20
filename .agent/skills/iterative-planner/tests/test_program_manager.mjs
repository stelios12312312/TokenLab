#!/usr/bin/env node
// test_program_manager.mjs — Program Packet validator and gate contracts.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { execFileSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const cli = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "program_manager.mjs");
const githubCli = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "github_ticket_review.mjs");
const fixturesDir = join(testDir, "fixtures", "programs");
const visualizerPayloadModule = join(repoRoot, "apps", "ive-visualizer", "scripts", "generate-live-payload.mjs");
const programDispositionModule = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "lib", "program_disposition.mjs");
const gateSatisfiabilityModule = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "lib", "gate_satisfiability.mjs");
const verificationStatusVocabularyModule = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "lib", "verification_status_vocabulary.mjs");
const programPacketModule = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "lib", "program_packet.mjs");
const githubReviewModule = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "github_ticket_review.mjs");
const NODE = process.execPath;
const { buildProgramDisposition } = await import(pathToFileURL(programDispositionModule).href);
const { getVerificationStatusVocabulary } = await import(pathToFileURL(verificationStatusVocabularyModule).href);
const { evaluateExternalPrerequisites, programPacketToFacts, validateProgramPacket } = await import(pathToFileURL(programPacketModule).href);
const { renderText: renderGithubReviewText, runPublish, runReview } = await import(pathToFileURL(githubReviewModule).href);

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

function fixture(name) {
  return join(fixturesDir, name);
}

function run(args, cwd = repoRoot, env = process.env) {
  try {
    const stdout = execFileSync(NODE, [cli, ...args], { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch { /* non-JSON command */ }
    return { ok: true, stdout, parsed };
  } catch (error) {
    const stdout = error.stdout || "";
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch { /* ignore */ }
    return { ok: false, stdout, stderr: error.stderr || "", parsed };
  }
}

function runGithub(args, cwd = repoRoot, env = process.env) {
  try {
    const stdout = execFileSync(NODE, [githubCli, ...args], { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch { /* non-JSON command */ }
    return { ok: true, stdout, parsed };
  } catch (error) {
    const stdout = error.stdout || "";
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch { /* ignore */ }
    return { ok: false, stdout, stderr: error.stderr || "", parsed };
  }
}

function hasError(result, code) {
  return (result.parsed?.errors || []).some((entry) => entry.code === code);
}

function errorMessages(result) {
  return [
    result.parsed?.error,
    ...(result.parsed?.errors || []).map((entry) => entry?.message),
  ].filter(Boolean).join("\n");
}

const helpResult = run(["--help"]);
assert(
  helpResult.ok
    && helpResult.stdout.includes("--defer-open")
    && helpResult.stdout.includes("--expect-deferred-count <n>"),
  "Program Manager help documents the guarded reversible open-deferral lane",
);

console.log("\nProgram Manager Contracts\n");

assert(existsSync(cli), "program_manager.mjs exists");

assert(existsSync(gateSatisfiabilityModule), "provider-neutral gate satisfiability module exists");
if (existsSync(gateSatisfiabilityModule)) {
  const { evaluateGateSatisfiability } = await import(pathToFileURL(gateSatisfiabilityModule).href);
  const genericRequirement = {
    id: "artifact.store_configuration",
    description: "Artifact storage needs a configured destination.",
    applicable: true,
    satisfied: false,
    reason: "No artifact store destination is configured.",
    resolution_options: [
      { id: "configure", action: "Configure an artifact store destination." },
      { id: "waive", action: "Record a governed waiver." },
    ],
  };
  const unresolved = evaluateGateSatisfiability({ requirements: [genericRequirement], waivers: [], decisions: [] });
  assert(!unresolved.ok && unresolved.requirements[0]?.status === "resolution_required", "provider-neutral evaluator blocks a non-GitHub structural requirement");
  assert(unresolved.requirements[0]?.resolution_options?.length === 2, "provider-neutral evaluator preserves concrete resolution options");

  const waived = evaluateGateSatisfiability({
    requirements: [genericRequirement],
    waivers: [{ requirement_id: genericRequirement.id, decision_ref: "DEC-STORE-WAIVER", reason: "Temporary local artifact review." }],
    decisions: [{
      id: "DEC-STORE-WAIVER",
      type: "gate_requirement_waiver",
      subject_ref: genericRequirement.id,
      rationale: "Temporary local artifact review while storage is unavailable.",
    }],
  });
  assert(waived.ok && waived.requirements[0]?.status === "waived", "provider-neutral evaluator accepts a matching decision-backed waiver");

  const invalidWaiver = evaluateGateSatisfiability({
    requirements: [genericRequirement],
    waivers: [{ requirement_id: genericRequirement.id, decision_ref: "DEC-MISSING", reason: "Unbacked." }],
    decisions: [],
  });
  assert(!invalidWaiver.ok && invalidWaiver.requirements[0]?.status === "invalid_waiver", "provider-neutral evaluator rejects an unbacked waiver");

  const invalidRedundantWaiver = evaluateGateSatisfiability({
    requirements: [{ ...genericRequirement, satisfied: true }],
    waivers: [{ requirement_id: genericRequirement.id, decision_ref: "DEC-MISSING", reason: "Unbacked." }],
    decisions: [],
  });
  assert(!invalidRedundantWaiver.ok && invalidRedundantWaiver.requirements[0]?.status === "invalid_waiver", "provider-neutral evaluator validates waiver governance even when the requirement is otherwise satisfied");

  const unknownRequirementWaiver = evaluateGateSatisfiability({
    requirements: [{ ...genericRequirement, satisfied: true }],
    waivers: [{ requirement_id: "artifact.unknown_requirement", decision_ref: "DEC-UNKNOWN", reason: "Unknown requirement." }],
    decisions: [{
      id: "DEC-UNKNOWN",
      type: "gate_requirement_waiver",
      subject_ref: "artifact.unknown_requirement",
      rationale: "Attempt to waive an unregistered requirement.",
    }],
  });
  assert(!unknownRequirementWaiver.ok && unknownRequirementWaiver.requirements.some((entry) => entry.id === "artifact.unknown_requirement" && entry.status === "invalid_waiver"), "provider-neutral evaluator rejects waivers for unregistered requirements");
}

let result = run(["check", "--program", fixture("valid_ready.json"), "--json"]);
assert(result.ok && result.parsed.status === "PASS", "valid Program Packet passes check");
assert(result.parsed.counts.tickets === 1, "valid Program Packet reports ticket count");

{
  const knownStoryIds = new Set(["US-TEST-001"]);
  const mature = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
  mature.story_refs = ["US-GHOST-PROGRAM"];
  mature.epics[0].story_refs = ["US-GHOST-EPIC"];
  mature.tickets[0].story_refs = ["US-GHOST-TICKET"];
  mature.acceptance_criteria[0].story_refs = ["US-GHOST-CRITERION"];
  const matureResult = validateProgramPacket(mature, { cwd: repoRoot, storyIds: knownStoryIds });
  for (const code of ["program_unknown_story", "epic_unknown_story", "ticket_unknown_story", "acceptance_unknown_story"]) {
    assert(matureResult.errors.some((entry) => entry.code === code), `mature Program validation fails on ${code}`);
  }

  const draft = structuredClone(mature);
  draft.status = "design";
  draft.tickets[0].lifecycle = "proposed";
  const draftResult = validateProgramPacket(draft, { cwd: repoRoot, storyIds: knownStoryIds });
  assert(!draftResult.errors.some((entry) => entry.code === "program_unknown_story"), "design Program keeps unknown Program refs advisory");
  assert(draftResult.warnings.some((entry) => entry.code === "ticket_unknown_story"), "proposed ticket keeps unknown story refs advisory");
}

result = run(["verify", "design-to-ready", "--program", fixture("valid_ready.json"), "--json"]);
assert(result.ok && result.parsed.status === "PASS", "design-to-ready accepts a traceable ready packet");

result = run(["verify", "ready-to-execution", "--program", fixture("valid_ready.json"), "--json"]);
assert(result.ok && result.parsed.status === "PASS", "ready-to-execution accepts ready ticket evidence");

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-github-policy-"));
  try {
    const packetPath = join(tmp, "program_packet.json");
    const packet = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
    delete packet.tickets[0].external_refs;
    packet.remote_mode = "local-only";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
    result = run(["check", "--program", packetPath, "--json"], tmp);
    assert(result.ok && result.parsed.status === "PASS", "local-only ready ticket without GitHub issue passes validation");
    const localFacts = run(["facts", "--program", packetPath], tmp);
    assert(localFacts.ok && localFacts.stdout.includes("program_remote_mode('PGM-TEST', 'local_only')"), "facts command emits local-only remote mode");
    assert(localFacts.ok && !localFacts.stdout.includes("program_github_issue_mirror_required('PGM-TEST')"), "local-only facts do not require GitHub issue mirrors");

    delete packet.remote_mode;
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
    result = run(["check", "--program", packetPath, "--remote-mode", "remote-sync", "--json"], tmp);
    assert(!result.ok && hasError(result, "ready_ticket_missing_github_issue"), "remote-sync ready ticket without GitHub issue fails JS validation");
    assert(!result.ok && hasError(result, "program_ready_ticket_missing_github_issue"), "remote-sync ready ticket without GitHub issue fails ontology validation");
    const publish = await runPublish({
      command: "publish",
      program: packetPath,
      ticket: "T-001",
      repo: "owner/repo",
      project: null,
      remoteMode: "remote-sync",
      write: false,
      json: true,
    }, {
      cwd: tmp,
      env: {},
      clock: () => new Date("2026-07-14T00:00:00.000Z"),
    });
    assert(publish.status === "PASS" && publish.issue?.action === "planned", "publish permits the target GitHub mirror precondition that the publish action resolves");
    assert(publish.program_packet_validation?.remote_policy?.effective_mode === "remote-sync", "publish validates the Program under its explicit remote mode and repository");
    assert(publish.program_packet_validation?.errors?.some((entry) => entry.code === "ready_ticket_missing_github_issue"), "publish preserves the target missing-mirror validation observation");
    assert(publish.publish_preflight?.self_resolving_preconditions?.some((entry) => entry.code === "ready_ticket_missing_github_issue") && publish.publish_preflight?.blockers?.length === 0, "publish classifies only the target missing mirror as a self-resolving precondition");
    const text = run(["check", "--program", packetPath, "--remote-mode", "remote-sync"], tmp);
    const lines = text.stdout.trim().split(/\n/).filter(Boolean);
    assert(!text.ok && lines.length <= 10, "blocked check default output is capped at 10 lines");
    assert(lines.slice(0, 3).some((line) => /^Blockers: \d+/.test(line)), "blocked check default output shows blocker count in first three lines");
    assert(lines.some((line) => line.includes("ready_ticket_missing_github_issue")), "blocked check default output shows a top blocker");
    const artifactLine = lines.find((line) => line.startsWith("Artifact: "));
    const artifactRel = artifactLine?.replace(/^Artifact:\s*/, "");
    assert(Boolean(artifactRel) && existsSync(join(tmp, artifactRel)), "blocked check default output references a result artifact");
    const artifact = JSON.parse(readFileSync(join(tmp, artifactRel), "utf-8"));
    assert(artifact.status === "FAIL" && Array.isArray(artifact.errors), "blocked check artifact contains full JSON result");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-gate-satisfiability-"));
  const emptyRemoteEnv = {
    PLANNER_REMOTE_MODE: "",
    PLANNER_REPOSITORY: "",
    GITHUB_REPOSITORY: "",
  };
  try {
    const unresolvedPath = join(tmp, "plans", "programs", "unresolved", "program_packet.json");
    result = run(["init", "--program", "unresolved", "--json"], tmp, emptyRemoteEnv);
    assert(!result.ok && !existsSync(unresolvedPath), "init without mode or repository blocks before writing a Program Packet");
    assert(hasError(result, "program_gate_requirement_resolution_required"), "unresolved init emits the canonical structural requirement code");
    const initRequirement = result.parsed?.gate_satisfiability?.requirements?.find((entry) => entry.id === "program.remote_policy_resolution");
    assert(initRequirement?.status === "resolution_required", "unresolved init exposes structured resolution-required status");
    assert(initRequirement?.resolution_options?.map((entry) => entry.id).join(",") === "set_local_only,provide_repository,record_governed_waiver", "unresolved init exposes all three operator resolution classes");

    const textRoot = join(tmp, "text");
    mkdirSync(textRoot, { recursive: true });
    const textResult = run(["init", "--program", "unresolved-text"], textRoot, emptyRemoteEnv);
    assert(!textResult.ok && `${textResult.stdout}\n${textResult.stderr}`.includes("Resolution:"), "unresolved init human output surfaces the forced decision loudly");

    const legacyPath = join(tmp, "legacy-unresolved.json");
    const legacyPacket = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
    delete legacyPacket.remote_mode;
    delete legacyPacket.remote_policy;
    delete legacyPacket.repository_slug;
    delete legacyPacket.tickets[0].external_refs;
    writeFileSync(legacyPath, `${JSON.stringify(legacyPacket, null, 2)}\n`, "utf-8");
    const legacyBefore = readFileSync(legacyPath);
    result = run(["check", "--program", legacyPath, "--json"], tmp, emptyRemoteEnv);
    const legacyAfter = readFileSync(legacyPath);
    assert(!result.ok && hasError(result, "program_gate_requirement_resolution_required"), "first check touch blocks an unresolved legacy Program Packet");
    assert(hasError(result, "program_gate_requirement_unsatisfied"), "Program Prolog ontology mirrors the unresolved JavaScript requirement");
    assert(legacyBefore.equals(legacyAfter), "blocked first-touch check does not mutate the legacy packet");

    const localPath = join(tmp, "explicit-local.json");
    const localPacket = structuredClone(legacyPacket);
    localPacket.remote_mode = "local-only";
    writeFileSync(localPath, `${JSON.stringify(localPacket, null, 2)}\n`, "utf-8");
    const localBefore = readFileSync(localPath);
    const localHash = createHash("sha256").update(localBefore).digest("hex");
    result = run(["check", "--program", localPath, "--json"], tmp, emptyRemoteEnv);
    const localAfter = readFileSync(localPath);
    assert(result.ok && result.parsed?.gate_satisfiability?.requirements?.find((entry) => entry.id === "program.remote_policy_resolution")?.status === "satisfied", "explicit local-only passes without a repository and exposes satisfied provenance");
    assert(localBefore.equals(localAfter) && createHash("sha256").update(localAfter).digest("hex") === localHash, "satisfiable local-only check preserves packet bytes and SHA-256");
    const localFacts = run(["facts", "--program", localPath], tmp, emptyRemoteEnv);
    assert(localFacts.stdout.includes("program_gate_requirement_satisfied('PGM-TEST', 'program.remote_policy_resolution')"), "facts expose the satisfied Program policy requirement");

    const repoPath = join(tmp, "repository-backed.json");
    const repoPacket = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
    delete repoPacket.remote_mode;
    delete repoPacket.remote_policy;
    writeFileSync(repoPath, `${JSON.stringify(repoPacket, null, 2)}\n`, "utf-8");
    const repoBefore = readFileSync(repoPath);
    result = run(["check", "--program", repoPath, "--json"], tmp, emptyRemoteEnv);
    assert(!result.ok && hasError(result, "program_gate_requirement_resolution_required"), "historical repository identity does not resolve an absent policy mode");
    assert(result.parsed?.remote_policy?.repository?.slug === "owner/repo" && result.parsed?.remote_policy?.mode_source === "compatibility_default", "repository identity remains observable without becoming policy authority");
    assert(repoBefore.equals(readFileSync(repoPath)), "repository-backed unresolved check leaves the packet untouched");

    const cliRepoPath = join(tmp, "cli-repository-backed.json");
    writeFileSync(cliRepoPath, `${JSON.stringify(legacyPacket, null, 2)}\n`, "utf-8");
    result = run(["check", "--program", cliRepoPath, "--repo", "owner/repo", "--json"], tmp, emptyRemoteEnv);
    assert(!result.ok && result.parsed?.remote_policy?.repository?.slug === "owner/repo" && hasError(result, "program_gate_requirement_unsatisfied"), "CLI repository identity alone is shared as data but does not select remote policy");
    const cliRemotePacket = structuredClone(legacyPacket);
    cliRemotePacket.tickets[0].external_refs = [{ kind: "github_issue", issue_number: 101, repo: "owner/repo" }];
    writeFileSync(cliRepoPath, `${JSON.stringify(cliRemotePacket, null, 2)}\n`, "utf-8");
    result = run(["check", "--program", cliRepoPath, "--repo", "owner/repo", "--remote-mode", "remote-sync", "--json"], tmp, emptyRemoteEnv);
    assert(result.ok && result.parsed?.remote_policy?.effective_mode === "remote-sync", "CLI remote mode plus repository identity explicitly resolves remote-sync");

    const missingRepoPath = join(tmp, "remote-missing-repository.json");
    const missingRepoPacket = structuredClone(legacyPacket);
    missingRepoPacket.remote_mode = "remote-sync";
    writeFileSync(missingRepoPath, `${JSON.stringify(missingRepoPacket, null, 2)}\n`, "utf-8");
    result = run(["check", "--program", missingRepoPath, "--json"], tmp, emptyRemoteEnv);
    assert(!result.ok && result.parsed?.gate_satisfiability?.requirements?.find((entry) => entry.id === "program.remote_repository_identity")?.status === "resolution_required", "remote-sync without repository identity is structurally blocked");

    const ambiguousPath = join(tmp, "remote-ambiguous-repository.json");
    const ambiguousPacket = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
    delete ambiguousPacket.remote_mode;
    ambiguousPacket.tickets[0].external_refs.push({ kind: "github_issue", repo: "other/repo", issue_number: 99, url: "https://github.com/other/repo/issues/99" });
    writeFileSync(ambiguousPath, `${JSON.stringify(ambiguousPacket, null, 2)}\n`, "utf-8");
    result = run(["check", "--program", ambiguousPath, "--json"], tmp, emptyRemoteEnv);
    assert(!result.ok && result.parsed?.remote_policy?.repository?.status === "ambiguous", "conflicting repository identities fail instead of selecting one silently");

    const conflictingPacketRepositoryPath = join(tmp, "remote-conflicting-packet-repository.json");
    const conflictingPacketRepository = structuredClone(legacyPacket);
    conflictingPacketRepository.remote_mode = "remote-sync";
    conflictingPacketRepository.remote_policy = { repository_slug: "owner/primary" };
    conflictingPacketRepository.repository_slug = "owner/secondary";
    writeFileSync(conflictingPacketRepositoryPath, `${JSON.stringify(conflictingPacketRepository, null, 2)}\n`, "utf-8");
    result = run(["check", "--program", conflictingPacketRepositoryPath, "--json"], tmp, emptyRemoteEnv);
    assert(!result.ok && result.parsed?.remote_policy?.repository?.status === "ambiguous", "conflicting packet-level repository aliases fail instead of selecting by field order");

    const conflictingPacketModePath = join(tmp, "remote-conflicting-packet-mode.json");
    const conflictingPacketMode = structuredClone(legacyPacket);
    conflictingPacketMode.remote_mode = "local-only";
    conflictingPacketMode.remote_policy = { mode: "remote-sync", repository_slug: "owner/repo" };
    writeFileSync(conflictingPacketModePath, `${JSON.stringify(conflictingPacketMode, null, 2)}\n`, "utf-8");
    result = run(["check", "--program", conflictingPacketModePath, "--json"], tmp, emptyRemoteEnv);
    assert(!result.ok && hasError(result, "program_remote_mode_invalid") && /conflicting/i.test(errorMessages(result)), "conflicting packet-level remote-mode aliases fail instead of selecting by field order");

    const waiverPath = join(tmp, "waived-policy.json");
    const waiverPacket = structuredClone(legacyPacket);
    waiverPacket.decisions = [{
      id: "DEC-POLICY-WAIVER",
      type: "gate_requirement_waiver",
      subject_ref: "program.remote_policy_resolution",
      rationale: "Retain the compatibility fallback for this local Program until policy review.",
    }];
    waiverPacket.gate_requirement_waivers = [{
      requirement_id: "program.remote_policy_resolution",
      decision_ref: "DEC-POLICY-WAIVER",
      reason: "Policy review is scheduled; local-only compatibility is accepted meanwhile.",
    }];
    writeFileSync(waiverPath, `${JSON.stringify(waiverPacket, null, 2)}\n`, "utf-8");
    result = run(["check", "--program", waiverPath, "--json"], tmp, emptyRemoteEnv);
    assert(result.ok && result.parsed?.gate_satisfiability?.requirements?.find((entry) => entry.id === "program.remote_policy_resolution")?.status === "waived", "matching Program decision governs an unresolved-policy waiver");
    const waiverFacts = run(["facts", "--program", waiverPath], tmp, emptyRemoteEnv);
    assert(waiverFacts.stdout.includes("program_gate_requirement_waived('PGM-TEST', 'program.remote_policy_resolution')"), "facts expose governed waiver provenance");

    const invalidWaiverPath = join(tmp, "invalid-waiver.json");
    const invalidWaiverPacket = structuredClone(waiverPacket);
    invalidWaiverPacket.decisions = [];
    writeFileSync(invalidWaiverPath, `${JSON.stringify(invalidWaiverPacket, null, 2)}\n`, "utf-8");
    result = run(["check", "--program", invalidWaiverPath, "--json"], tmp, emptyRemoteEnv);
    assert(!result.ok && hasError(result, "program_gate_requirement_waiver_invalid"), "unbacked Program waiver fails loudly");

    const dispositionPath = join(tmp, "unresolved-disposition.json");
    const dispositionPacket = structuredClone(legacyPacket);
    dispositionPacket.tickets[0].lifecycle = "deferred";
    writeFileSync(dispositionPath, `${JSON.stringify(dispositionPacket, null, 2)}\n`, "utf-8");
    const dispositionBefore = readFileSync(dispositionPath);
    const disposition = buildProgramDisposition({
      cwd: tmp,
      deferredPrograms: [dispositionPath],
      write: true,
      clock: () => new Date("2026-07-17T00:00:00.000Z"),
    });
    assert(disposition.status === "BLOCKED" && disposition.blockers.some((entry) => entry.code === "packet_gate_requirement_unresolved"), "first disposition touch cannot grandfather an unresolved structural gate requirement");
    assert(dispositionBefore.equals(readFileSync(dispositionPath)), "blocked disposition leaves the unresolved Program Packet byte-for-byte unchanged");

    const localInit = run(["init", "--program", "explicit-local-init", "--remote-mode", "local-only", "--json"], tmp, emptyRemoteEnv);
    const localInitPacket = JSON.parse(readFileSync(join(tmp, "plans", "programs", "explicit-local-init", "program_packet.json"), "utf-8"));
    assert(localInit.ok && localInitPacket.remote_mode === "local-only", "init persists an explicit local-only decision");

    const repoInit = run(["init", "--program", "repository-init", "--repo", "owner/repo", "--json"], tmp, emptyRemoteEnv);
    const repoInitPacket = JSON.parse(readFileSync(join(tmp, "plans", "programs", "repository-init", "program_packet.json"), "utf-8"));
    assert(repoInit.ok && repoInitPacket.remote_mode === "local-only" && repoInitPacket.remote_policy?.repository_slug === "owner/repo", "init repository identity persists the local-only resolution");

    const canonicalRepoInit = run(["init", "--program", "canonical-repository-init", "--repo", "https://github.com/owner/repo.git", "--json"], tmp, emptyRemoteEnv);
    const canonicalRepoInitPacket = JSON.parse(readFileSync(join(tmp, "plans", "programs", "canonical-repository-init", "program_packet.json"), "utf-8"));
    assert(canonicalRepoInit.ok && canonicalRepoInitPacket.remote_policy?.repository_slug === "owner/repo", "init persists normalized owner/name repository identity after accepting a canonical GitHub URL");

    const conflictInit = run(["init", "--program", "conflict-init", "--remote-mode", "local-only", "--repo", "owner/repo", "--json"], tmp, emptyRemoteEnv);
    assert(!conflictInit.ok && /mutually exclusive/.test(conflictInit.parsed?.error || ""), "init rejects local-only plus repository identity as conflicting resolution paths");

    const waiverInit = run([
      "init", "--program", "waiver-init",
      "--waive-gate-requirement", "program.remote_policy_resolution",
      "--waiver-decision", "DEC-INIT-WAIVER",
      "--waiver-reason", "Governed compatibility period.",
      "--json",
    ], tmp, emptyRemoteEnv);
    const waiverInitPacket = JSON.parse(readFileSync(join(tmp, "plans", "programs", "waiver-init", "program_packet.json"), "utf-8"));
    assert(waiverInit.ok && waiverInitPacket.gate_requirement_waivers?.[0]?.decision_ref === "DEC-INIT-WAIVER", "init can record a complete governed waiver resolution");

    const partialWaiver = run(["init", "--program", "partial-waiver", "--waive-gate-requirement", "program.remote_policy_resolution", "--json"], tmp, emptyRemoteEnv);
    assert(!partialWaiver.ok && /must be provided together/.test(partialWaiver.parsed?.error || ""), "init rejects partial governed waiver flags");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-github-required-research-"));
  try {
    const packetPath = join(tmp, "program_packet.json");
    const packet = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
    packet.tickets[0].type = "research";
    delete packet.tickets[0].external_refs;
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
    result = run(["check", "--program", packetPath, "--remote-mode", "remote-sync", "--json"], tmp);
    assert(!result.ok && hasError(result, "ready_ticket_missing_github_issue"), "remote-sync ready research ticket without GitHub issue fails JS validation");
    assert(!result.ok && hasError(result, "program_ready_ticket_missing_github_issue"), "remote-sync ready research ticket without GitHub issue fails ontology validation");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-remote-mode-policy-"));
  try {
    const packetPath = join(tmp, "program_packet.json");
    const packet = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
    delete packet.tickets[0].external_refs;
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");

    result = run(["check", "--program", packetPath, "--json"], tmp, { PLANNER_REMOTE_MODE: "remote-sync" });
    assert(!result.ok && hasError(result, "ready_ticket_missing_github_issue"), "PLANNER_REMOTE_MODE=remote-sync requires GitHub issue mirrors");

    packet.remote_mode = "remote-sync";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
    result = run(["check", "--program", packetPath, "--json"], tmp, { PLANNER_REMOTE_MODE: "local-only" });
    assert(!result.ok && hasError(result, "ready_ticket_missing_github_issue"), "packet remote_mode=remote-sync keeps GitHub issue mirror requirement");
    const syncFacts = run(["facts", "--program", packetPath], tmp, { PLANNER_REMOTE_MODE: "local-only" });
    assert(syncFacts.ok && syncFacts.stdout.includes("program_github_issue_mirror_required('PGM-TEST')"), "remote-sync packet facts require GitHub issue mirrors");

    packet.remote_mode = "local-only";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
    result = run(["check", "--program", packetPath, "--remote-mode", "remote-sync", "--json"], tmp);
    assert(result.ok && result.parsed.status === "PASS", "packet remote_mode=local-only remains local-only even when CLI requests remote-sync");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-project-item-linked-"));
  try {
    const packetPath = join(tmp, "program_packet.json");
    const packet = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
    packet.tickets[0].external_refs = [{
      kind: "github_project_item",
      repo: "owner/repo",
      issue_number: 42,
      project_item_id: "PVTI_item",
      url: "https://github.com/owner/repo/issues/42",
    }];
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
    result = run(["check", "--program", packetPath, "--json"], tmp);
    assert(result.ok && result.parsed.status === "PASS", "linked GitHub Project item satisfies ready ticket issue mirror requirement");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-generic-ac-"));
  try {
    const packetPath = join(tmp, "program_packet.json");
    const packet = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
    packet.acceptance_criteria[0].text = "The proposed ticket has traceable scope, acceptance criteria, and verification evidence before it can become ready.";
    packet.tickets[0].acceptance_quality_required = true;
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
    result = run(["check", "--program", packetPath, "--json"], tmp);
    assert(!result.ok && hasError(result, "ready_ticket_generic_acceptance"), "ready ticket with placeholder acceptance text fails validation");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-transition-"));
  try {
    const packetPath = join(tmp, "program_packet.json");
    const packet = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
    packet.status = "design";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");

    result = run(["verify", "design-to-ready", "--program", packetPath, "--json"], tmp);
    assert(result.ok && result.parsed?.program_status_transition?.transition_written === false, "verify dry-run reports but does not write status transition");
    assert(JSON.parse(readFileSync(packetPath, "utf-8")).status === "design", "verify dry-run leaves Program Packet status unchanged");

    result = run(["verify", "design-to-ready", "--program", packetPath, "--write", "--json"], tmp);
    const writtenPacket = JSON.parse(readFileSync(packetPath, "utf-8"));
    assert(result.ok && result.parsed?.program_status_transition?.transition_written === true, "verify --write advances program status on passing gate");
    assert(result.parsed.program_status_transition.previous_status === "design", "status transition reports previous status");
    assert(result.parsed.program_status_transition.new_status === "ready", "status transition reports new status");
    assert(writtenPacket.status === "ready", "verify --write persists advanced program status");

    result = run(["verify", "design-to-ready", "--program", packetPath, "--write", "--json"], tmp);
    assert(result.ok && result.parsed?.program_status_transition?.transition_written === false, "verify --write is idempotent when target status is already current");

    writtenPacket.status = "executing";
    writeFileSync(packetPath, `${JSON.stringify(writtenPacket, null, 2)}\n`, "utf-8");
    result = run(["verify", "design-to-ready", "--program", packetPath, "--write", "--json"], tmp);
    assert(result.ok && result.parsed?.program_status_transition?.status === "already_past_gate", "design-to-ready is idempotent when program status is already past ready");
    assert(JSON.parse(readFileSync(packetPath, "utf-8")).status === "executing", "design-to-ready --write does not downgrade executing program status");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-transition-fail-"));
  try {
    const packetPath = join(tmp, "program_packet.json");
    const packet = JSON.parse(readFileSync(fixture("missing_epic_story.json"), "utf-8"));
    packet.status = "design";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");

    result = run(["verify", "design-to-ready", "--program", packetPath, "--write", "--json"], tmp);
    assert(!result.ok && result.parsed?.program_status_transition?.transition_written === false, "verify --write does not transition failed gates");
    assert(JSON.parse(readFileSync(packetPath, "utf-8")).status === "design", "failed verify --write leaves Program Packet status unchanged");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-review-state-"));
  try {
    const packetPath = join(tmp, "program_packet.json");
    const packet = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
    packet.tickets[0].lifecycle = "review_ready";
    packet.tickets[0].review_status = "submitted";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
    result = run(["check", "--program", packetPath, "--json"], tmp);
    assert(result.ok && result.parsed.status === "PASS", "review lifecycle aliases validate without becoming execution lifecycle states");

    const facts = run(["facts", "--program", packetPath], tmp);
    assert(facts.ok && facts.stdout.includes("ticket_lifecycle('T-001', 'proposed')"), "review lifecycle aliases emit proposed effective lifecycle facts");

    packet.tickets[0].review_status = "nonsense";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
    result = run(["check", "--program", packetPath, "--json"], tmp);
    assert(!result.ok && hasError(result, "ticket_invalid_review_status"), "invalid ticket review_status fails validation");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

result = run(["facts", "--program", fixture("valid_ready.json")]);
assert(result.ok && result.stdout.includes("program('PGM-TEST'"), "facts command emits program facts");
assert(result.stdout.includes("program_remote_mode('PGM-TEST', 'remote_sync')"), "facts command emits the fixture's explicit remote-sync policy");
assert(result.stdout.includes("ticket('T-001'"), "facts command emits ticket facts");
assert(result.stdout.includes("ticket_github_issue('T-001')"), "facts command emits GitHub issue mirror facts");
assert(result.stdout.includes("ticket_github_issue_ref('T-001', 'owner/repo', 9016)"), "facts command emits detailed GitHub issue mirror refs");

result = run(["check", "--program", fixture("missing_epic_story.json"), "--json"]);
assert(!result.ok && hasError(result, "epic_without_story"), "missing epic story fails");
assert(hasError(result, "program_epic_without_story"), "missing epic story also fails through ontology invariant");

result = run(["check", "--program", fixture("migration_without_contract.json"), "--json"]);
assert(!result.ok && hasError(result, "migration_ticket_missing_contract"), "migration without compatibility contract fails");

result = run(["check", "--program", fixture("delete_without_census.json"), "--json"]);
assert(!result.ok && hasError(result, "delete_move_ticket_missing_census"), "delete/move ticket without census fails");

result = run(["check", "--program", fixture("canonical_delete_without_replacement.json"), "--json"]);
assert(!result.ok && hasError(result, "canonical_delete_without_replacement"), "canonical delete without replacement decision fails");

result = run(["check", "--program", fixture("dependency_cycle.json"), "--json"]);
assert(!result.ok && hasError(result, "ticket_dependency_cycle"), "dependency cycle fails");

result = run(["verify", "execution-to-program-validate", "--program", fixture("child_plan_dir_missing.json"), "--json"]);
assert(!result.ok && hasError(result, "required_child_plan_dir_missing"), "verified ticket with fabricated child_plan dir fails");
assert(!result.ok && !hasError(result, "required_child_plan_not_closed"), "missing-dir failure does not double-emit required_child_plan_not_closed");

// F-001 null-path closure: verified ticket with plan_dir=null + inline state=closed must FAIL with the new error code.
// The check fires BEFORE required_child_plan_dir_missing because plan_dir presence is checked first.
result = run(["verify", "execution-to-program-validate", "--program", fixture("child_plan_dir_required.json"), "--json"]);
assert(!result.ok && hasError(result, "required_child_plan_dir_required"), "verified ticket with null plan_dir fails validation (F-001)");
assert(!result.ok && !hasError(result, "required_child_plan_dir_missing"), "null-path failure is distinct from missing-path failure");
assert(!result.ok && !hasError(result, "required_child_plan_not_closed"), "null-path failure does not fall through to not_closed");

{
  function quantPacket({ cited = false, withLedger = cited } = {}) {
    const packet = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
    packet.id = "PGM-QUANT-SCOPE";
    packet.title = "Quant optimizer negative verdict fixture";
    packet.status = "executing";
    packet.goal = "Run quant optimizer search and avoid overclaiming negative no_go strategy verdicts.";
    packet.persona_packs = ["quant", "assumptions_challenger", "traceability"];
    packet.tickets[0].ticket_type = "quant_exploration";
    packet.tickets[0].title = "Evaluate bounded quant optimizer region";
    packet.tickets[0].lifecycle = "done";
    packet.verification_matrix[0].result = "pass";
    packet.verification_matrix[0].result_source = "manual";
    if (withLedger) {
      packet.hypothesis_space = {
        dimensions: {
          families: { tested: ["ta_momentum"], untested: ["ml", "order_flow"] },
          intervals: { tested: ["1h"], untested: ["15m", "4h"] },
          directions: { tested: ["long_only"], untested: ["short", "long_short"] },
        },
      };
    }
    packet.findings_ledger = [{
      id: "F-NEG-001",
      grade: "negative",
      summary: "No candidate met promotion criteria.",
      ...(cited ? { tested_region_ref: "hypothesis_space.dimensions" } : {}),
    }];
    packet.program_verdict = {
      verdict: "no_go",
      rationale: "Bounded region did not pass.",
      ...(cited ? { tested_region: "families=ta_momentum; intervals=1h; directions=long_only" } : {}),
    };
    return packet;
  }

  const tmp = mkdtempSync(join(tmpdir(), "program-manager-scope-citation-"));
  try {
    const packetPath = join(tmp, "program_packet.json");
    writeFileSync(packetPath, `${JSON.stringify(quantPacket({ cited: false, withLedger: false }), null, 2)}\n`, "utf-8");
    result = run(["check", "--program", packetPath, "--json"], tmp);
    assert(result.ok && result.parsed?.warnings?.some((entry) => entry.code === "hypothesis_space_ledger_missing"), "quant packet without hypothesis_space warns during compatibility window");

    result = run(["verify", "execution-to-program-validate", "--program", packetPath, "--json"], tmp);
    assert(!result.ok && hasError(result, "negative_finding_missing_tested_region"), "quant negative finding without tested region fails program validation");
    assert(!result.ok && hasError(result, "program_no_go_missing_tested_region"), "quant no_go verdict without tested region fails program validation");

    writeFileSync(packetPath, `${JSON.stringify(quantPacket({ cited: true, withLedger: true }), null, 2)}\n`, "utf-8");
    result = run(["verify", "execution-to-program-validate", "--program", packetPath, "--json"], tmp);
    assert(result.ok && result.parsed.status === "PASS", "quant negative/no_go packet with tested-region citations passes program validation");

    const facts = run(["facts", "--program", packetPath], tmp);
    assert(facts.ok && facts.stdout.includes("scope_citation_required('PGM-QUANT-SCOPE')"), "program facts emit scope citation requirement");
    assert(facts.stdout.includes("finding_tested_region_cited('F-NEG-001')"), "program facts emit finding tested-region citation");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// F-010 closure: parameterized validator-invariant test.
//
// Enumerates policy=required × lifecycle × falsy-plan_dir to catch the next
// "N branches for N+1 modes" regression structurally rather than waiting for a
// red-team audit to find it. The base fixture is the F-001 child_plan_dir_required
// shape; we mutate plan_dir and lifecycle in memory and write to tmpdirs.
{
  const baseFixture = JSON.parse(readFileSync(fixture("child_plan_dir_required.json"), "utf-8"));
  const FALSY_PLAN_DIRS = [null, ""];
  const LIFECYCLES_THAT_FIRE = ["verified", "closed"];
  const LIFECYCLES_THAT_DO_NOT_FIRE = ["draft", "in_progress", "ready", "done"];
  const EXPECTED_CODE = "required_child_plan_dir_required";

  function cloneWith(planDir, lifecycle) {
    const copy = JSON.parse(JSON.stringify(baseFixture));
    copy.tickets[0].lifecycle = lifecycle;
    copy.tickets[0].child_plan.plan_dir = planDir;
    return copy;
  }

  for (const lifecycle of LIFECYCLES_THAT_FIRE) {
    for (const planDir of FALSY_PLAN_DIRS) {
      const tmp = mkdtempSync(join(tmpdir(), "f010-fire-"));
      try {
        const packetPath = join(tmp, "program_packet.json");
        writeFileSync(packetPath, JSON.stringify(cloneWith(planDir, lifecycle)));
        const r = run(["verify", "execution-to-program-validate", "--program", packetPath, "--json"]);
        const planDirLabel = planDir === null ? "null" : '""';
        assert(!r.ok && hasError(r, EXPECTED_CODE),
          `F-010: policy=required + lifecycle=${lifecycle} + plan_dir=${planDirLabel} emits ${EXPECTED_CODE}`);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  }

  // Boundary: when lifecycle is not verified/closed, the validator must NOT
  // fire even with a falsy plan_dir. Catches the symmetric regression class
  // where someone widens VERIFIED_OR_CLOSED without re-checking branch coverage.
  for (const lifecycle of LIFECYCLES_THAT_DO_NOT_FIRE) {
    const tmp = mkdtempSync(join(tmpdir(), "f010-skip-"));
    try {
      const packetPath = join(tmp, "program_packet.json");
      writeFileSync(packetPath, JSON.stringify(cloneWith(null, lifecycle)));
      const r = run(["check", "--program", packetPath, "--json"]);
      const codes = (r.parsed?.errors || []).map((e) => e.code);
      assert(!codes.includes(EXPECTED_CODE),
        `F-010: policy=required + lifecycle=${lifecycle} + plan_dir=null does NOT emit ${EXPECTED_CODE}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-childplan-"));
  try {
    const childPlanDir = join(tmp, "plans", "plan_child_open");
    const fixtureSrc = JSON.parse(readFileSync(fixture("child_plan_not_closed.json"), "utf-8"));
    // Materialize a real on-disk child plan dir whose state is not CLOSE.
    const stateDir = join(childPlanDir);
    const fsLib = await import("fs");
    fsLib.mkdirSync(stateDir, { recursive: true });
    fsLib.writeFileSync(join(stateDir, "state.json"), JSON.stringify({ state: "EXECUTE" }));
    fixtureSrc.tickets[0].child_plan.plan_dir = "plan_child_open";
    delete fixtureSrc.tickets[0].child_plan.state;
    const packetPath = join(tmp, "program_packet.json");
    fsLib.writeFileSync(packetPath, JSON.stringify(fixtureSrc));
    const r = run(["verify", "execution-to-program-validate", "--program", packetPath, "--json"], tmp);
    assert(!r.ok && hasError(r, "required_child_plan_not_closed"), "verified ticket with real-but-open child plan dir fails with not_closed");
    assert(!r.ok && !hasError(r, "required_child_plan_dir_missing"), "real-dir + open-state path does not emit dir_missing");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  function writeChildPlan(tmp, name, stateJson) {
    const dir = join(tmp, "plans", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), `${JSON.stringify(stateJson, null, 2)}\n`, "utf-8");
    return `plans/${name}`;
  }

  function childFailurePacket(tmp, childState, lifecycle = "in_progress") {
    const packet = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
    packet.status = "executing";
    packet.tickets[0].lifecycle = lifecycle;
    packet.tickets[0].child_plan = {
      policy: "required",
      plan_dir: childState ? writeChildPlan(tmp, "plan_child_failed", childState) : "plans/plan_child_missing",
      reason: "Fixture child plan.",
    };
    return packet;
  }

  const cases = [
    [
      "blocked-state",
      { state: "BLOCKED", transitions: [] },
      "child plan blocked state fails until propagated",
    ],
    [
      "poisoned-tail",
      {
        state: "EXECUTE",
        transitions: [
          { gate: "plan-to-execute", gate_result: "FAIL", failure_codes: ["GATE-PLN-X"] },
          { gate: "plan-to-execute", gate_result: "FAIL", failure_codes: ["GATE-PLN-X"] },
          { gate: "plan-to-execute", gate_result: "FAIL", failure_codes: ["GATE-PLN-X"] },
        ],
      },
      "child plan poisoned gate tail fails until propagated",
    ],
    [
      "replan-loop",
      {
        state: "EXECUTE",
        transitions: [
          { to: "RE_PLAN", gate_result: "PASS" },
          { to: "RE_PLAN", gate_result: "PASS" },
          { to: "RE_PLAN", gate_result: "PASS" },
        ],
      },
      "child plan re-plan loop fails until propagated",
    ],
  ];

  for (const [name, childState, label] of cases) {
    const tmp = mkdtempSync(join(tmpdir(), `program-manager-child-failure-${name}-`));
    try {
      const packetPath = join(tmp, "program_packet.json");
      writeFileSync(packetPath, `${JSON.stringify(childFailurePacket(tmp, childState), null, 2)}\n`, "utf-8");
      const r = run(["check", "--program", packetPath, "--json"], tmp);
      assert(!r.ok && hasError(r, "child_plan_failure_not_propagated"), label);

      const propagated = childFailurePacket(tmp, childState, "blocked");
      writeFileSync(packetPath, `${JSON.stringify(propagated, null, 2)}\n`, "utf-8");
      const propagatedCheck = run(["check", "--program", packetPath, "--json"], tmp);
      assert(propagatedCheck.ok && propagatedCheck.parsed?.status === "PASS", `${label}: blocked lifecycle is accepted propagation`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const awaitingTmp = mkdtempSync(join(tmpdir(), "program-manager-child-failure-awaiting-"));
  try {
    const packetPath = join(awaitingTmp, "program_packet.json");
    const awaiting = childFailurePacket(awaitingTmp, cases[1][1]);
    awaiting.tickets[0].awaiting_external_action = {
      kind: "operator_run",
      reason: "The child repair is recovering locally while terminal acceptance waits on an operator receipt.",
      expected_evidence: {
        type: "json_match",
        root: "reports/ive/autonomous_dogfood_runs",
        match: { outcome: "PASS" },
      },
      recorded_at: "2026-07-11T14:40:00.000Z",
    };
    writeFileSync(packetPath, `${JSON.stringify(awaiting, null, 2)}\n`, "utf-8");
    const r = run(["check", "--program", packetPath, "--json"], awaitingTmp);
    assert(r.ok && !hasError(r, "child_plan_failure_not_propagated"), "valid awaiting_external_action explicitly propagates a child-plan failure while the ticket remains in_progress");
  } finally {
    rmSync(awaitingTmp, { recursive: true, force: true });
  }

  const closedAfterValidateRetriesTmp = mkdtempSync(join(tmpdir(), "program-manager-child-closed-after-validate-retries-"));
  try {
    const packetPath = join(closedAfterValidateRetriesTmp, "program_packet.json");
    const closedAfterValidateRetries = {
      state: "CLOSE",
      transitions: [
        { from: "VALIDATE", to: "VALIDATE", gate_result: "FAIL", failure_codes: ["GATE-SEM-002"] },
        { from: "VALIDATE", to: "VALIDATE", gate_result: "FAIL", failure_codes: ["GATE-SEM-002"] },
        { from: "VALIDATE", to: "VALIDATE", gate_result: "FAIL", failure_codes: ["GATE-SEM-002"] },
        { from: "VALIDATE", to: "CLOSE", gate_result: "PASS", failure_codes: [] },
      ],
    };
    writeFileSync(packetPath, `${JSON.stringify(childFailurePacket(closedAfterValidateRetriesTmp, closedAfterValidateRetries), null, 2)}\n`, "utf-8");
    const r = run(["check", "--program", packetPath, "--json"], closedAfterValidateRetriesTmp);
    assert(r.ok && r.parsed?.status === "PASS", "closed child plan after successful validate-to-close pass does not remain history-poisoned");
  } finally {
    rmSync(closedAfterValidateRetriesTmp, { recursive: true, force: true });
  }

  const missingTmp = mkdtempSync(join(tmpdir(), "program-manager-child-failure-missing-"));
  try {
    const packetPath = join(missingTmp, "program_packet.json");
    writeFileSync(packetPath, `${JSON.stringify(childFailurePacket(missingTmp, null, "ready"), null, 2)}\n`, "utf-8");
    const r = run(["check", "--program", packetPath, "--json"], missingTmp);
    assert(!r.ok && hasError(r, "child_plan_failure_not_propagated"), "missing child plan directory fails until propagated");

    const packet = childFailurePacket(missingTmp, null, "blocked");
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
    const nextReady = run(["next-ready", "--program", packetPath, "--json"], missingTmp);
    assert(nextReady.ok && (nextReady.parsed?.tickets || []).length === 0, "propagated blocked child failure is excluded from next-ready");
  } finally {
    rmSync(missingTmp, { recursive: true, force: true });
  }
}

result = run(["verify", "validate-to-program-close", "--program", fixture("program_close_deferred_missing_decision.json"), "--json"]);
assert(!result.ok && hasError(result, "deferred_ticket_missing_decision"), "program close with undecided deferral fails");

result = run(["verify", "validate-to-program-close", "--program", fixture("program_close_child_plan_missing.json"), "--json"]);
assert(!result.ok && hasError(result, "required_child_plan_dir_missing"), "closed program with fabricated child_plan dir fails JS validation");
assert(!result.ok && hasError(result, "program_child_plan_not_closed"), "closed program with fabricated child_plan dir fails ontology validation");

{
  function closedReviewPacket(mutator = () => {}) {
    const packet = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
    packet.status = "closed";
    packet.tickets[0].lifecycle = "closed";
    packet.tickets[0].child_plan = { policy: "not_required", plan_dir: null, reason: "Fixture" };
    packet.verification_matrix[0].result = "pass";
    packet.acceptance_criteria.push({
      id: "AC-PGM",
      scope: "program",
      subject_ref: "PGM-TEST",
      text: "Program close has passing evidence.",
      story_refs: ["US-001"],
      maintenance_rationale: null,
    });
    packet.verification_matrix.push({
      id: "VM-PGM",
      scope: "program",
      subject_ref: "PGM-TEST",
      acceptance_criterion_ref: "AC-PGM",
      proof_type: "proof:artifact_review",
      command_or_action: "Review program close fixture",
      pass_means: "Program row passes",
      result: "pass",
    });
    mutator(packet);
    return packet;
  }

  const cases = [
    [
      "review-not-run",
      (packet) => { packet.tickets[0].review_status = "not_run"; },
      "ticket_closure_review_not_run",
      "program_ticket_review_not_run",
      "closed ticket with review_status:not_run fails closure",
    ],
    [
      "persona-needs-evidence",
      (packet) => { packet.tickets[0].persona_review = { status: "needs_evidence" }; },
      "ticket_closure_persona_review_needs_evidence",
      "program_ticket_persona_review_needs_evidence",
      "closed ticket with persona_review.status:needs_evidence fails closure",
    ],
  ];
  for (const [name, mutator, jsCode, ontologyCode, label] of cases) {
    const tmp = mkdtempSync(join(tmpdir(), `program-manager-close-${name}-`));
    try {
      const packetPath = join(tmp, "program_packet.json");
      writeFileSync(packetPath, `${JSON.stringify(closedReviewPacket(mutator), null, 2)}\n`, "utf-8");
      const r = run(["verify", "validate-to-program-close", "--program", packetPath, "--json"], tmp);
      assert(!r.ok && hasError(r, jsCode), `${label} through JS validation`);
      assert(!r.ok && hasError(r, ontologyCode), `${label} through ontology validation`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const reviewReadyTmp = mkdtempSync(join(tmpdir(), "program-manager-close-review-ready-"));
  try {
    const packetPath = join(reviewReadyTmp, "program_packet.json");
    writeFileSync(packetPath, `${JSON.stringify(closedReviewPacket((packet) => {
      packet.tickets[0].review_status = "review_ready";
      packet.tickets[0].persona_review = { status: "accepted" };
    }), null, 2)}\n`, "utf-8");
    const r = run(["verify", "validate-to-program-close", "--program", packetPath, "--json"], reviewReadyTmp);
    assert(r.ok && r.parsed?.status === "PASS", "closed ticket with review_ready/accepted review metadata passes");
  } finally {
    rmSync(reviewReadyTmp, { recursive: true, force: true });
  }

  function administrativeClosurePacket({ disposition = true, reviewStatus = "unavailable" } = {}) {
    return {
      version: 1,
      id: "PGM-ADMIN-CLOSE",
      title: "Administrative closure fixture",
      status: "executing",
      goal: "Close obsolete backlog without delivery evidence.",
      remote_mode: "local-only",
      story_refs: ["US-001"],
      epics: [{
        id: "EP-ADMIN",
        title: "Administration",
        story_refs: ["US-001"],
        ticket_refs: ["T-ADMIN"],
      }],
      tickets: [{
        id: "T-ADMIN",
        epic_id: "EP-ADMIN",
        title: "Obsolete backlog ticket",
        type: "feature",
        lifecycle: "closed",
        review_status: reviewStatus,
        gap_refs: ["GAP-ADMIN"],
        acceptance_criteria: [],
        verification_refs: [],
        external_refs: [],
        ...(disposition ? {
          backlog_disposition: {
            classification: "fold_into_existing_ticket",
            decision_ref: "D-ADMIN",
            receipt_ref: "reports/ive/lifecycle_dispositions/admin.json",
            source: "program_manager_disposition",
          },
        } : {}),
      }],
      acceptance_criteria: [],
      dependencies: [],
      compatibility_contracts: [],
      migration_boundaries: [],
      deletion_move_census: [],
      verification_matrix: [],
      decisions: [{
        id: "D-ADMIN",
        type: "backlog_disposition",
        subject_ref: "T-ADMIN",
        status: "accepted",
        decision: "Fold this obsolete ticket into an existing Program Packet ticket.",
      }],
    };
  }

  const adminTmp = mkdtempSync(join(tmpdir(), "program-manager-admin-close-"));
  try {
    const packetPath = join(adminTmp, "program_packet.json");
    writeFileSync(packetPath, `${JSON.stringify(administrativeClosurePacket(), null, 2)}\n`, "utf-8");
    const r = run(["check", "--program", packetPath, "--json"], adminTmp);
    assert(r.ok && r.parsed?.status === "PASS", "administrative backlog closure passes Program Manager check without delivery evidence");
    const facts = run(["facts", "--program", packetPath], adminTmp);
    assert(facts.ok && facts.stdout.includes("ticket_administrative_closure('T-ADMIN')"), "administrative backlog closure emits Prolog parity fact");

    writeFileSync(packetPath, `${JSON.stringify(administrativeClosurePacket({ disposition: false }), null, 2)}\n`, "utf-8");
    const seeded = run(["check", "--program", packetPath, "--json"], adminTmp);
    assert(!seeded.ok && hasError(seeded, "ready_ticket_missing_acceptance"), "ordinary evidence-free closed ticket still fails JS acceptance evidence");
    assert(!seeded.ok && hasError(seeded, "program_ready_ticket_missing_acceptance"), "ordinary evidence-free closed ticket still fails ontology acceptance evidence");
  } finally {
    rmSync(adminTmp, { recursive: true, force: true });
  }

  if (existsSync(visualizerPayloadModule)) {
    const { generateLiveGraphPayload } = await import(pathToFileURL(visualizerPayloadModule).href);
    const visualizerTmp = mkdtempSync(join(tmpdir(), "program-manager-admin-visualizer-"));
    try {
      const planDir = join(visualizerTmp, "plans", "plan_visualizer");
      const packetPath = join(visualizerTmp, "plans", "programs", "admin", "program_packet.json");
      const storyPath = join(visualizerTmp, "reports", "user_story_audit", "story_registry.json");
      mkdirSync(planDir, { recursive: true });
      mkdirSync(dirname(packetPath), { recursive: true });
      mkdirSync(dirname(storyPath), { recursive: true });
      writeFileSync(join(planDir, "state.json"), `${JSON.stringify({ state: "EXECUTE", goal: "Visualizer fixture" }, null, 2)}\n`, "utf-8");
      writeFileSync(packetPath, `${JSON.stringify({
        ...administrativeClosurePacket(),
        tickets: [{
          ...administrativeClosurePacket().tickets[0],
          lifecycle: "deferred",
        }],
      }, null, 2)}\n`, "utf-8");
      writeFileSync(storyPath, `${JSON.stringify({ version: 1, stories: [], infrastructure_stories: [] }, null, 2)}\n`, "utf-8");
      const payload = generateLiveGraphPayload({
        repoRoot: visualizerTmp,
        planDir,
        programPacketPath: packetPath,
        storyRegistryPath: storyPath,
        generatedAt: "2026-07-09T00:00:00.000Z",
      });
      const ticketNode = payload.graph?.nodes?.find((entry) => entry.id === "T-ADMIN");
      assert(ticketNode?.className?.includes("flow-node-closed"), "visualizer payload treats dispositioned deferred ticket as resolved");
      assert(payload.program?.health_summary?.checks?.some((check) => check.id === "ticket-lifecycle" && check.detail.includes("1 ticket")), "visualizer payload keeps disposition-resolved ticket in health summary");
    } finally {
      rmSync(visualizerTmp, { recursive: true, force: true });
    }
  } else {
    assert(true, "visualizer payload test skipped when app tree is not installed");
  }

  function deferredDispositionPacket({
    programId = "PGM-DEFERRED-DISPOSITION",
    ticketId = "T-DEFERRED",
    decisionId = "D-ADMIN",
  } = {}) {
    return {
      version: 1,
      id: programId,
      title: "Deferred disposition fixture",
      status: "executing",
      goal: "Promote already-dispositioned deferred backlog tickets only on explicit --close.",
      remote_mode: "local-only",
      story_refs: ["US-001"],
      epics: [{
        id: "EP-ADMIN",
        title: "Administration",
        story_refs: ["US-001"],
        ticket_refs: [ticketId],
      }],
      tickets: [{
        id: ticketId,
        epic_id: "EP-ADMIN",
        title: "Superseded deferred ticket",
        type: "feature",
        lifecycle: "deferred",
        gap_refs: ["GAP-ADMIN"],
        deferral_decision_ref: decisionId,
        close_reason: `Superseded by the consolidated repair lane (decision ${decisionId}).`,
      }],
      acceptance_criteria: [],
      dependencies: [],
      compatibility_contracts: [],
      migration_boundaries: [],
      deletion_move_census: [],
      verification_matrix: [],
      decisions: [{
        id: decisionId,
        type: "backlog_disposition",
        subject_ref: ticketId,
        status: "accepted",
        decision: "Close obsolete deferred backlog because it was superseded by the consolidated repair lane.",
      }],
    };
  }

  const dispositionTmp = mkdtempSync(join(tmpdir(), "program-manager-disposition-admin-close-"));
  try {
    const packetPath = join(dispositionTmp, "program_packet.json");
    const classifyReceipt = join(dispositionTmp, "classify-receipt.json");
    const closeReceipt = join(dispositionTmp, "close-receipt.json");
    writeFileSync(packetPath, `${JSON.stringify(deferredDispositionPacket(), null, 2)}\n`, "utf-8");

    const classified = run([
      "disposition",
      "--deferred-program", packetPath,
      "--output", classifyReceipt,
      "--write",
      "--json",
    ], dispositionTmp);
    const afterClassify = JSON.parse(readFileSync(packetPath, "utf-8"));
    assert(classified.ok && classified.parsed?.deferred?.[0]?.action === "classified_written", "disposition --write stamps classification only");
    assert(afterClassify.tickets[0].lifecycle === "deferred", "disposition --write leaves deferred lifecycle unchanged");
    assert(afterClassify.tickets[0].backlog_disposition?.decision_ref === "D-ADMIN", "classification stamp carries decision_ref");

    const closed = run([
      "disposition",
      "--deferred-program", packetPath,
      "--output", closeReceipt,
      "--close",
      "--write",
      "--json",
    ], dispositionTmp);
    const afterClose = JSON.parse(readFileSync(packetPath, "utf-8"));
    assert(closed.ok && closed.parsed?.deferred?.[0]?.action === "admin_closed", "disposition --close --write promotes already-dispositioned deferred ticket");
    assert(afterClose.tickets[0].lifecycle === "closed", "administrative close persists closed lifecycle");
    assert(afterClose.tickets[0].review_status === "unavailable", "administrative close records review_status unavailable instead of review_ready");
    assert(!afterClose.tickets[0].persona_review, "administrative close does not fabricate persona review evidence");
    assert(String(afterClose.tickets[0].close_reason || "").includes("close_obsolete") && String(afterClose.tickets[0].close_reason || "").includes("D-ADMIN"), "administrative close reason names classification and decision");

    const repeated = run([
      "disposition",
      "--deferred-program", packetPath,
      "--close",
      "--write",
      "--json",
    ], dispositionTmp);
    assert(repeated.ok && repeated.parsed?.deferred?.[0]?.action === "already_closed", "disposition --close is idempotent for already administratively closed tickets");
  } finally {
    rmSync(dispositionTmp, { recursive: true, force: true });
  }

  function openDeferralPacket({
    programId = "PGM-OPEN-DEFERRAL",
    includeUnhandled = false,
    keepTicketId = "T-KEEP",
  } = {}) {
    const ticket = (id, lifecycle, title) => ({
      id,
      epic_id: "EP-OPEN",
      title,
      type: "feature",
      lifecycle,
      gap_refs: [`GAP-${id}`],
    });
    const tickets = [
      ticket("T-PROPOSED", "proposed", "Proposed backlog candidate"),
      ticket("T-BLOCKED", "blocked", "Blocked backlog candidate"),
      ticket(keepTicketId, "proposed", "Explicitly protected work"),
      {
        ...ticket("T-ALREADY-DEFERRED", "deferred", "Already deferred backlog"),
        deferral_decision_ref: "D-ALREADY-DEFERRED",
        backlog_disposition: {
          classification: "revive",
          decision_ref: "D-ALREADY-DEFERRED",
          receipt_ref: "reports/ive/lifecycle_dispositions/existing.json",
          source: "program_manager_disposition",
          updated_at: "2026-08-05T00:00:00.000Z",
        },
      },
    ];
    if (includeUnhandled) tickets.push(ticket("T-IN-PROGRESS", "in_progress", "Unprotected active work"));
    return {
      version: 1,
      id: programId,
      title: "Open backlog deferral fixture",
      status: "executing",
      goal: "Defer only explicitly selected open backlog while preserving protected work.",
      remote_mode: "local-only",
      story_refs: ["US-001"],
      epics: [{
        id: "EP-OPEN",
        title: "Open backlog",
        story_refs: ["US-001"],
        ticket_refs: tickets.map((entry) => entry.id),
      }],
      tickets,
      acceptance_criteria: [],
      dependencies: [],
      compatibility_contracts: [],
      migration_boundaries: [],
      deletion_move_census: [],
      verification_matrix: [],
      decisions: [{
        id: "D-ALREADY-DEFERRED",
        type: "deferral",
        subject_ref: "T-ALREADY-DEFERRED",
        status: "accepted",
        rationale: "Existing reversible backlog deferral.",
        decision: "Preserve this ticket for possible revival.",
      }],
    };
  }

  const openDeferralTmp = mkdtempSync(join(tmpdir(), "program-manager-open-deferral-"));
  try {
    const packetPath = join(openDeferralTmp, "program_packet.json");
    const dryReceipt = join(openDeferralTmp, "dry-receipt.json");
    const writeReceipt = join(openDeferralTmp, "write-receipt.json");
    writeFileSync(packetPath, `${JSON.stringify(openDeferralPacket(), null, 2)}\n`, "utf-8");
    const originalBytes = readFileSync(packetPath);
    const originalPacket = JSON.parse(originalBytes.toString("utf-8"));
    const originalKeep = JSON.stringify(originalPacket.tickets.find((entry) => entry.id === "T-KEEP"));
    const originalDeferred = JSON.stringify(originalPacket.tickets.find((entry) => entry.id === "T-ALREADY-DEFERRED"));

    const dryRun = run([
      "disposition",
      "--deferred-program", packetPath,
      "--defer-open",
      "--keep-ticket", "T-KEEP",
      "--expect-deferred-count", "2",
      "--output", dryReceipt,
      "--json",
    ], openDeferralTmp);
    assert(dryRun.ok && dryRun.parsed?.counts?.open_deferred === 2, "disposition --defer-open dry-run selects the exact proposed/blocked candidate count");
    assert(dryRun.parsed?.deferred_by_program?.[0]?.candidate_count === 2, "open deferral receipt reports per-Program candidate count");
    assert(dryRun.parsed?.deferred?.filter((entry) => entry.action === "would_defer_open").length === 2, "open deferral dry-run reports would_defer_open actions");
    assert(readFileSync(packetPath).equals(originalBytes) && !existsSync(dryReceipt), "open deferral dry-run writes neither Program Packet nor receipt");

    const written = run([
      "disposition",
      "--deferred-program", packetPath,
      "--defer-open",
      "--keep-ticket", "T-KEEP",
      "--expect-deferred-count", "2",
      "--output", writeReceipt,
      "--write",
      "--json",
    ], openDeferralTmp);
    const afterWrite = JSON.parse(readFileSync(packetPath, "utf-8"));
    const newlyDeferred = afterWrite.tickets.filter((entry) => ["T-PROPOSED", "T-BLOCKED"].includes(entry.id));
    assert(written.ok && written.parsed?.counts?.open_deferred === 2 && written.parsed?.counts?.packets_written === 1, "open deferral write persists the exact expected candidate set");
    assert(newlyDeferred.every((entry) => entry.lifecycle === "deferred" && entry.deferral_decision_ref === `D-DEFER-${entry.id}`), "open deferral writes lifecycle and deterministic decision refs");
    assert(newlyDeferred.every((entry) => entry.backlog_disposition?.classification === "revive" && entry.backlog_disposition?.source === "program_manager_disposition" && entry.backlog_disposition?.receipt_ref === "write-receipt.json"), "open deferral writes reversible backlog disposition metadata tied to the receipt");
    assert(newlyDeferred.every((entry) => afterWrite.decisions.some((decision) => decision.id === entry.deferral_decision_ref && decision.type === "deferral" && decision.subject_ref === entry.id && decision.status === "accepted" && decision.rationale)), "open deferral writes accepted per-ticket deferral decisions");
    assert(JSON.stringify(afterWrite.tickets.find((entry) => entry.id === "T-KEEP")) === originalKeep, "open deferral preserves explicit KEEP ticket byte-equivalent JSON");
    assert(JSON.stringify(afterWrite.tickets.find((entry) => entry.id === "T-ALREADY-DEFERRED")) === originalDeferred, "open deferral preserves already-deferred ticket byte-equivalent JSON");
    const checked = run(["check", "--program", packetPath, "--json"], openDeferralTmp);
    const facts = run(["facts", "--program", packetPath], openDeferralTmp);
    assert(checked.ok && checked.parsed?.status === "PASS", "open deferral output passes Program Manager validation");
    assert(facts.ok && facts.stdout.includes("ticket_deferred_by_decision('T-PROPOSED', 'D-DEFER-T-PROPOSED')"), "open deferral output emits ontology deferral-decision facts");

    const repeatedBytes = readFileSync(packetPath);
    const repeated = run([
      "disposition",
      "--deferred-program", packetPath,
      "--defer-open",
      "--keep-ticket", "T-KEEP",
      "--expect-deferred-count", "0",
      "--write",
      "--json",
    ], openDeferralTmp);
    assert(repeated.ok && repeated.parsed?.counts?.open_deferred === 0 && readFileSync(packetPath).equals(repeatedBytes), "open deferral is idempotent after candidates have been deferred");
  } finally {
    rmSync(openDeferralTmp, { recursive: true, force: true });
  }

  const openDeferralRejectTmp = mkdtempSync(join(tmpdir(), "program-manager-open-deferral-reject-"));
  try {
    const packetPath = join(openDeferralRejectTmp, "program_packet.json");
    const duplicatePacketPath = join(openDeferralRejectTmp, "duplicate", "program_packet.json");
    mkdirSync(dirname(duplicatePacketPath), { recursive: true });
    const resetPacket = (packet = openDeferralPacket()) => {
      writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
      return readFileSync(packetPath);
    };
    let before = resetPacket();
    let rejected = run(["disposition", "--deferred-program", packetPath, "--defer-open", "--keep-ticket", "T-KEEP", "--write", "--json"], openDeferralRejectTmp);
    assert(!rejected.ok && errorMessages(rejected).includes("--expect-deferred-count") && readFileSync(packetPath).equals(before), "open deferral rejects a missing expected count before writes");

    before = resetPacket();
    rejected = run(["disposition", "--deferred-program", packetPath, "--defer-open", "--keep-ticket", "T-KEEP", "--expect-deferred-count", "2", "--close", "--write", "--json"], openDeferralRejectTmp);
    assert(!rejected.ok && errorMessages(rejected).includes("incompatible") && readFileSync(packetPath).equals(before), "open deferral rejects incompatible --close before writes");

    before = resetPacket();
    rejected = run(["disposition", "--deferred-program", packetPath, "--defer-open", "--keep-ticket", "T-KEEP", "--expect-deferred-count", "3", "--write", "--json"], openDeferralRejectTmp);
    assert(!rejected.ok && errorMessages(rejected).includes("expected 3") && readFileSync(packetPath).equals(before), "open deferral rejects a candidate-count mismatch before writes");

    before = resetPacket();
    rejected = run(["disposition", "--deferred-program", packetPath, "--defer-open", "--keep-ticket", "T-MISSING", "--expect-deferred-count", "3", "--write", "--json"], openDeferralRejectTmp);
    assert(!rejected.ok && errorMessages(rejected).includes("T-MISSING") && readFileSync(packetPath).equals(before), "open deferral rejects a KEEP id that does not resolve exactly once");

    before = resetPacket();
    rejected = run(["disposition", "--deferred-program", packetPath, "--deferred-program", packetPath, "--defer-open", "--keep-ticket", "T-KEEP", "--expect-deferred-count", "2", "--write", "--json"], openDeferralRejectTmp);
    assert(!rejected.ok && errorMessages(rejected).includes("selected more than once") && readFileSync(packetPath).equals(before), "open deferral rejects duplicate Program Packet selection before writes");

    before = resetPacket(openDeferralPacket({ includeUnhandled: true }));
    rejected = run(["disposition", "--deferred-program", packetPath, "--defer-open", "--keep-ticket", "T-KEEP", "--expect-deferred-count", "2", "--write", "--json"], openDeferralRejectTmp);
    assert(!rejected.ok && errorMessages(rejected).includes("T-IN-PROGRESS") && readFileSync(packetPath).equals(before), "open deferral rejects unprotected actionable lifecycle outside proposed/blocked before writes");

    before = resetPacket();
    writeFileSync(duplicatePacketPath, `${JSON.stringify(openDeferralPacket({ programId: "PGM-OPEN-DEFERRAL-DUPLICATE" }), null, 2)}\n`, "utf-8");
    const duplicateBefore = readFileSync(duplicatePacketPath);
    rejected = run(["disposition", "--deferred-program", packetPath, "--deferred-program", duplicatePacketPath, "--defer-open", "--keep-ticket", "T-KEEP", "--expect-deferred-count", "4", "--write", "--json"], openDeferralRejectTmp);
    assert(!rejected.ok && errorMessages(rejected).includes("T-KEEP") && readFileSync(packetPath).equals(before) && readFileSync(duplicatePacketPath).equals(duplicateBefore), "open deferral rejects a KEEP id that resolves in multiple selected Programs before writes");
  } finally {
    rmSync(openDeferralRejectTmp, { recursive: true, force: true });
  }

  const sameSecondTmp = mkdtempSync(join(tmpdir(), "program-manager-disposition-same-second-"));
  try {
    const packetAPath = join(sameSecondTmp, "program-a", "program_packet.json");
    const packetBPath = join(sameSecondTmp, "program-b", "program_packet.json");
    mkdirSync(dirname(packetAPath), { recursive: true });
    mkdirSync(dirname(packetBPath), { recursive: true });
    writeFileSync(packetAPath, `${JSON.stringify(deferredDispositionPacket({
      programId: "PGM-DEFERRED-A",
      ticketId: "T-DEFERRED-A",
      decisionId: "D-ADMIN-A",
    }), null, 2)}\n`, "utf-8");
    writeFileSync(packetBPath, `${JSON.stringify(deferredDispositionPacket({
      programId: "PGM-DEFERRED-B",
      ticketId: "T-DEFERRED-B",
      decisionId: "D-ADMIN-B",
    }), null, 2)}\n`, "utf-8");

    const fixedClock = () => new Date("2026-07-09T09:13:03.456Z");
    const first = buildProgramDisposition({
      cwd: sameSecondTmp,
      deferredPrograms: [packetAPath],
      write: true,
      clock: fixedClock,
    });
    const second = buildProgramDisposition({
      cwd: sameSecondTmp,
      deferredPrograms: [packetBPath],
      write: true,
      clock: fixedClock,
    });
    const firstReceiptPath = join(sameSecondTmp, first.output_path);
    const secondReceiptPath = join(sameSecondTmp, second.output_path);
    const writtenA = JSON.parse(readFileSync(packetAPath, "utf-8"));
    const writtenB = JSON.parse(readFileSync(packetBPath, "utf-8"));
    const receiptA = JSON.parse(readFileSync(firstReceiptPath, "utf-8"));
    const receiptB = JSON.parse(readFileSync(secondReceiptPath, "utf-8"));

    assert(first.output_path !== second.output_path, "default disposition receipt paths are unique for same-second writes");
    assert(first.output_path.includes("20260709T091303456Z") && second.output_path.includes("20260709T091303456Z"), "default disposition receipt paths preserve millisecond precision");
    assert(first.output_path.includes("pgm-deferred-a") && second.output_path.includes("pgm-deferred-b"), "default disposition receipt paths include program identity slug");
    assert(existsSync(firstReceiptPath) && existsSync(secondReceiptPath), "same-second dispositions write both receipt files");
    assert(writtenA.tickets[0].backlog_disposition?.receipt_ref === first.output_path, "first ticket points to its own disposition receipt");
    assert(writtenB.tickets[0].backlog_disposition?.receipt_ref === second.output_path, "second ticket points to its own disposition receipt");
    assert(receiptA.deferred.some((entry) => entry.ticket_id === "T-DEFERRED-A") && !receiptA.deferred.some((entry) => entry.ticket_id === "T-DEFERRED-B"), "first receipt contains only first ticket disposition");
    assert(receiptB.deferred.some((entry) => entry.ticket_id === "T-DEFERRED-B") && !receiptB.deferred.some((entry) => entry.ticket_id === "T-DEFERRED-A"), "second receipt contains only second ticket disposition");
  } finally {
    rmSync(sameSecondTmp, { recursive: true, force: true });
  }

  const writeFailTmp = mkdtempSync(join(tmpdir(), "program-manager-close-write-fail-"));
  try {
    const packetPath = join(writeFailTmp, "program_packet.json");
    const packet = JSON.parse(readFileSync(fixture("program_close_child_plan_missing.json"), "utf-8"));
    packet.status = "validating";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
    const r = run(["verify", "validate-to-program-close", "--program", packetPath, "--write", "--json"], writeFailTmp);
    const writtenPacket = JSON.parse(readFileSync(packetPath, "utf-8"));
    assert(!r.ok && r.parsed?.program_status_transition?.transition_written === false, "failed validate-to-program-close --write does not persist closed status");
    assert(writtenPacket.status === "validating", "failed program close --write leaves Program Packet status unchanged");
  } finally {
    rmSync(writeFailTmp, { recursive: true, force: true });
  }
}

// Closed-ticket verification truth: final ticket lifecycles cannot keep stale
// failed or blank row results just because the program-level row passes.
{
  function closedPacketWithTicketResult(value, { omitResult = false } = {}) {
    const packet = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
    packet.status = "closed";
    packet.tickets[0].lifecycle = "closed";
    packet.acceptance_criteria.push({
      id: "AC-PGM",
      scope: "program",
      subject_ref: "PGM-TEST",
      text: "Program close has passing evidence.",
      story_refs: ["US-001"],
      maintenance_rationale: null,
    });
    if (omitResult) delete packet.verification_matrix[0].result;
    else packet.verification_matrix[0].result = value;
    packet.verification_matrix.push({
      id: "VM-PGM",
      scope: "program",
      subject_ref: "PGM-TEST",
      acceptance_criterion_ref: "AC-PGM",
      proof_type: "proof:artifact_review",
      command_or_action: "Review program close fixture",
      pass_means: "Program row passes",
      result: "pass",
    });
    return packet;
  }

  const cases = [
    ["fail", { omitResult: false }, "failing"],
    ["pass", { omitResult: true }, "blank"],
  ];
  for (const [value, options, label] of cases) {
    const tmp = mkdtempSync(join(tmpdir(), `program-manager-ticket-vm-${label}-`));
    try {
      const packetPath = join(tmp, "program_packet.json");
      writeFileSync(packetPath, `${JSON.stringify(closedPacketWithTicketResult(value, options), null, 2)}\n`, "utf-8");
      const r = run(["verify", "validate-to-program-close", "--program", packetPath, "--json"], tmp);
      assert(!r.ok && hasError(r, "ticket_verification_not_passed"), `closed ticket with ${label} verification row fails JS validation`);
      assert(!r.ok && hasError(r, "program_ticket_verification_not_passed"), `closed ticket with ${label} verification row fails ontology validation`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const tmp = mkdtempSync(join(tmpdir(), "program-manager-ticket-vm-waived-"));
  try {
    const packetPath = join(tmp, "program_packet.json");
    writeFileSync(packetPath, `${JSON.stringify(closedPacketWithTicketResult("accepted_risk"), null, 2)}\n`, "utf-8");
    const r = run(["verify", "validate-to-program-close", "--program", packetPath, "--json"], tmp);
    assert(r.ok && r.parsed?.status === "PASS", "closed ticket with accepted_risk verification row is allowed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  for (const status of getVerificationStatusVocabulary().contexts.program.statuses) {
    for (const form of status.forms) {
      const tmp = mkdtempSync(join(tmpdir(), `program-manager-ticket-vm-vocabulary-${status.kind}-`));
      try {
        const packetPath = join(tmp, "program_packet.json");
        writeFileSync(packetPath, `${JSON.stringify(closedPacketWithTicketResult(form), null, 2)}\n`, "utf-8");
        const r = run(["verify", "validate-to-program-close", "--program", packetPath, "--json"], tmp);
        if (status.satisfies) {
          assert(r.ok && r.parsed?.status === "PASS", `program verification form ${form} passes in JavaScript and Prolog`);
        } else {
          assert(!r.ok && hasError(r, "ticket_verification_not_passed"), `program verification form ${form} fails JavaScript validation`);
          assert(!r.ok && hasError(r, "program_ticket_verification_not_passed"), `program verification form ${form} fails Prolog validation`);
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  }
}

// Ticket close annotation gate: opt-in Program Packet tickets can require
// code-level @planner:proves links before done/verified/closed lifecycle.
{
  function writeFileUnder(tmp, relPath, content) {
    const abs = join(tmp, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }

  function annotationPacket(tmp, relPath, content, mutator = () => {}) {
    writeFileUnder(tmp, relPath, content);
    const packet = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
    packet.status = "executing";
    packet.tickets[0].lifecycle = "done";
    packet.tickets[0].child_plan = { policy: "not_required", plan_dir: null, reason: "Annotation close fixture." };
    packet.tickets[0].annotation_close_required = true;
    packet.tickets[0].code_refs = [relPath];
    packet.verification_matrix[0].result = "pass";
    mutator(packet);
    return packet;
  }

  const cases = [
    [
      "missing",
      "src/impl.mjs",
      "export const value = 1;\n",
      "ticket_close_annotation_missing",
      "missing @planner:proves blocks close annotation gate",
    ],
    [
      "wrong-story",
      "src/impl.mjs",
      "// @planner:proves = crit:AC-WRONG\nexport const value = 1;\n",
      "ticket_close_annotation_wrong_story",
      "wrong @planner:proves linkage blocks close annotation gate",
    ],
  ];

  for (const [name, relPath, content, code, label] of cases) {
    const tmp = mkdtempSync(join(tmpdir(), `program-manager-annotation-${name}-`));
    try {
      const packetPath = join(tmp, "program_packet.json");
      writeFileSync(packetPath, `${JSON.stringify(annotationPacket(tmp, relPath, content), null, 2)}\n`, "utf-8");
      const r = run(["check", "--program", packetPath, "--json"], tmp);
      assert(!r.ok && hasError(r, code), label);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const passTmp = mkdtempSync(join(tmpdir(), "program-manager-annotation-pass-"));
  try {
    const packetPath = join(passTmp, "program_packet.json");
    writeFileSync(packetPath, `${JSON.stringify(annotationPacket(
      passTmp,
      "src/impl.mjs",
      "// @planner:proves = crit:AC-001\nexport const value = 1;\n",
    ), null, 2)}\n`, "utf-8");
    const r = run(["check", "--program", packetPath, "--json"], passTmp);
    assert(r.ok && r.parsed?.status === "PASS", "matching @planner:proves satisfies close annotation gate");
  } finally {
    rmSync(passTmp, { recursive: true, force: true });
  }

  const nonCodeTmp = mkdtempSync(join(tmpdir(), "program-manager-annotation-non-code-"));
  try {
    const packetPath = join(nonCodeTmp, "program_packet.json");
    writeFileSync(packetPath, `${JSON.stringify(annotationPacket(nonCodeTmp, "docs/readme.md", "# Docs only\n"), null, 2)}\n`, "utf-8");
    const r = run(["check", "--program", packetPath, "--json"], nonCodeTmp);
    assert(r.ok && r.parsed?.status === "PASS", "non-code file scope is exempt from close annotation gate");
  } finally {
    rmSync(nonCodeTmp, { recursive: true, force: true });
  }

  const fixtureTmp = mkdtempSync(join(tmpdir(), "program-manager-annotation-fixture-"));
  try {
    const packetPath = join(fixtureTmp, "program_packet.json");
    writeFileSync(packetPath, `${JSON.stringify(annotationPacket(fixtureTmp, "fixtures/impl.mjs", "export const fixture = true;\n"), null, 2)}\n`, "utf-8");
    const r = run(["check", "--program", packetPath, "--json"], fixtureTmp);
    assert(r.ok && r.parsed?.status === "PASS", "fixture file scope does not pollute close annotation proof");
  } finally {
    rmSync(fixtureTmp, { recursive: true, force: true });
  }

  const waiverTmp = mkdtempSync(join(tmpdir(), "program-manager-annotation-waiver-"));
  try {
    const packetPath = join(waiverTmp, "program_packet.json");
    writeFileSync(packetPath, `${JSON.stringify(annotationPacket(
      waiverTmp,
      "src/generated.mjs",
      "export const generated = true;\n",
      (packet) => {
        packet.tickets[0].annotation_waivers = [{ path: "src/generated.mjs", reason: "generated code is regenerated from canonical templates" }];
      },
    ), null, 2)}\n`, "utf-8");
    const r = run(["check", "--program", packetPath, "--json"], waiverTmp);
    assert(r.ok && r.parsed?.status === "PASS", "substantive annotation waiver satisfies close annotation gate");
  } finally {
    rmSync(waiverTmp, { recursive: true, force: true });
  }
}

const tmp = mkdtempSync(join(tmpdir(), "program-manager-skip-"));
try {
  result = run(["check", "--json"], tmp);
  assert(result.ok && result.parsed.status === "SKIP", "missing Program Packet returns SKIP");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-init-"));
  try {
    result = run(["init", "--program", "z1-m3", "--title", "Z1 M3", "--goal", "Coordinate Z1 M3 work.", "--remote-mode", "local-only", "--json"], tmp);
    const packetPath = join(tmp, "plans", "programs", "z1-m3", "program_packet.json");
    const packet = JSON.parse(readFileSync(packetPath, "utf-8"));
    assert(result.ok && result.parsed.status === "PASS", "init creates a Program Packet");
    assert(packet.version === 1 && packet.status === "design", "init writes valid base packet metadata");
    assert(Array.isArray(packet.tickets) && Array.isArray(packet.verification_matrix), "init writes required empty arrays");
    const check = run(["check", "--program", packetPath, "--json"], tmp);
    assert(check.ok && check.parsed.status === "PASS", "init output passes Program Manager check");
    assert(check.parsed?.lifecycle_reconciliation?.status !== "UNAVAILABLE", "Program Manager check exercises lifecycle reconciliation without reader errors");
    const overwrite = run(["init", "--program", "z1-m3", "--json"], tmp);
    assert(!overwrite.ok && /already exists/.test(overwrite.parsed?.error || overwrite.stderr), "init refuses accidental overwrite");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-remote-mode-"));
  try {
    const init = run(["init", "--program", "remote-mode", "--remote-mode", "local-only", "--json"], tmp);
    const packetPath = join(tmp, "plans", "programs", "remote-mode", "program_packet.json");
    assert(init.ok && existsSync(packetPath), "remote-mode fixture initializes a packet");

    const local = run([
      "intake",
      "--program", packetPath,
      "--from-text", "Local-only draft intake remains offline.",
      "--write",
      "--json",
    ], tmp, { PLANNER_REMOTE_MODE: "local-only" });
    assert(local.ok && local.parsed?.remote_mode === "local-only", "local-only mode permits local text intake");

    const remoteIssue = run([
      "intake",
      "--program", packetPath,
      "--issue", "42",
      "--repo", "owner/repo",
      "--json",
    ], tmp, { PLANNER_REMOTE_MODE: "local-only" });
    assert(!remoteIssue.ok && /requires remote-read or remote-sync/.test(remoteIssue.parsed?.error || ""), "local-only mode blocks GitHub issue intake before remote access");

    const remoteProject = run([
      "intake",
      "--program", packetPath,
      "--project-item", "PVTI_item",
      "--repo", "owner/repo",
      "--json",
    ], tmp, { PLANNER_REMOTE_MODE: "local-only" });
    assert(!remoteProject.ok && /requires remote-read or remote-sync/.test(remoteProject.parsed?.error || ""), "local-only mode blocks GitHub Project item intake before remote access");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-intake-preserve-"));
  try {
    const init = run(["init", "--program", "preserve", "--remote-mode", "local-only", "--json"], tmp);
    const packetPath = join(tmp, "plans", "programs", "preserve", "program_packet.json");
    assert(init.ok && existsSync(packetPath), "preserve fixture initializes a packet");
    const sourceText = "Update planner workflow migration in .agent/skills/iterative-planner/scripts/program_manager.mjs with US-077 traceability.";
    const mock = JSON.stringify({
      status: "review_ready",
      summary: "Mock advisory.",
      findings: [],
      recommended_actions: [],
    });
    const first = run([
      "intake",
      "--program", packetPath,
      "--from-text", sourceText,
      "--title", "Preserve custom proof rows",
      "--write",
      "--json",
    ], tmp, { PLANNER_SUPERVISOR_MOCK_RESPONSE: mock });
    const ticketId = first.parsed?.candidate_ticket?.id;
    const acceptanceId = first.parsed?.candidate_ticket?.acceptance_criteria?.[0];
    const verificationId = first.parsed?.candidate_ticket?.verification_refs?.[0];
    assert(first.ok && ticketId && acceptanceId && verificationId, "preserve fixture creates intake ticket");
    assert(first.parsed?.ticket_intake_receipt?.github_publication === "opt_in", "local intake receipt requires GitHub publication before readiness");
    assert(first.parsed?.ticket_intake_receipt?.next_required_command?.includes("github_ticket_review.mjs publish"), "local intake next command points to GitHub publish");

    const packet = JSON.parse(readFileSync(packetPath, "utf-8"));
    const acceptance = packet.acceptance_criteria.find((entry) => entry.id === acceptanceId);
    const verification = packet.verification_matrix.find((entry) => entry.id === verificationId);
    acceptance.text = "Custom preserved acceptance row requires ripple_check and governed migration-bootstrap evidence.";
    verification.proof_type = "proof:test";
    verification.command_or_action = "node .agent/skills/iterative-planner/scripts/ripple_check.mjs && node .agent/skills/iterative-planner/tests/ive/run.mjs --only migration-bootstrap --json --no-manifest";
    verification.pass_means = "ripple_check and governed migration-bootstrap pass before the ticket can become ready.";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");

    const repeat = run([
      "intake",
      "--program", packetPath,
      "--from-text", sourceText,
      "--title", "Preserve custom proof rows",
      "--write",
      "--json",
    ], tmp, { PLANNER_SUPERVISOR_MOCK_RESPONSE: mock });
    assert(repeat.ok && repeat.parsed?.candidate_ticket?.id === ticketId, "repeat intake updates the same ticket");
    assert(repeat.parsed?.verification_rows?.[0]?.command_or_action?.includes("ripple_check.mjs"), "repeat intake preserves custom verification command");
    assert(repeat.parsed?.ticket_intake_receipt?.retro_recurrence_status === "pass", "preserved proof row satisfies recurrence guard");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-intake-substantive-"));
  try {
    const init = run(["init", "--program", "substantive", "--remote-mode", "local-only", "--json"], tmp);
    const packetPath = join(tmp, "plans", "programs", "substantive", "program_packet.json");
    assert(init.ok && existsSync(packetPath), "substantive fixture initializes a packet");
    const fsLib = await import("fs");
    const registryPath = join(tmp, "reports", "user_story_audit", "story_registry.json");
    fsLib.mkdirSync(dirname(registryPath), { recursive: true });
    fsLib.writeFileSync(registryPath, JSON.stringify({
      updated: "2026-06-22T00:00:00.000Z",
      stories: [],
      infrastructure_stories: [
        {
          id: "US-079",
          title: "Program Manager workflow traceability",
          status: "IMPLEMENTED",
        },
      ],
      consolidations: [],
    }, null, 2));

    const source = JSON.stringify([
      {
        id: "readable-body",
        title: "Render readable GitHub ticket bodies",
        text: "US-079 GitHub mirrors are currently published as a dense block that hides the user story, acceptance criteria, and proof path.",
        problem: "GitHub issue mirrors are hard to scan because planner evidence is rendered as an unstructured block.",
        proposed_change: "Render stable Markdown sections for problem, proposed change, story context, acceptance criteria, verification, and metadata.",
        acceptance_bullets: [
          "Published GitHub issue bodies use stable Markdown sections for problem, proposed change, story context, acceptance criteria, verification, and metadata.",
        ],
        verification_plan: [
          "node .agent/skills/iterative-planner/tests/test_program_manager.mjs",
        ],
        story_context: [
          {
            id: "US-079",
            relevance: "Planner operators need readable GitHub mirrors to understand why the ticket exists and how it will be accepted.",
          },
        ],
        quant_scope: "planner_core",
      },
    ]);

    const intake = run([
      "intake",
      "--program", packetPath,
      "--from-json-array", source,
      "--write",
      "--json",
    ], tmp);
    const ticket = intake.parsed?.candidate_ticket || intake.parsed?.candidate_tickets?.[0];
    const acceptance = intake.parsed?.acceptance_criteria?.[0];
    const receipt = intake.parsed?.ticket_intake_receipt || intake.parsed?.ticket_intake_receipts?.[0];
    assert(intake.ok && ticket?.id, "JSON intake creates a candidate ticket");
    assert(ticket.acceptance_quality_required === true, "JSON intake opts new tickets into strict acceptance quality");
    assert(ticket.problem.includes("hard to scan"), "intake ticket records source-backed problem context");
    assert(ticket.proposed_change.includes("stable Markdown sections"), "intake ticket records source-backed proposed change");
    assert(acceptance?.text?.includes("stable Markdown sections"), "intake acceptance criteria use substantive source-backed text");
    assert(!acceptance?.text?.includes("traceable scope, acceptance criteria, and verification evidence"), "intake acceptance criteria avoid generic placeholder text");
    assert(ticket.story_context?.[0]?.title === "Program Manager workflow traceability", "intake story context includes registry story title");
    assert(ticket.story_context?.[0]?.relevance?.includes("readable GitHub mirrors"), "intake story context includes relevance explanation");
    assert(receipt?.story_context_refs?.includes("US-079"), "Ticket Intake Receipt lists story context refs");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// T-INTAKE-7920A5B7 closure: --remediate converts blocked advisory actions
// into explicit dry-run/write task packets without overriding deterministic gates.
{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-remediate-"));
  try {
    const packetPath = join(tmp, "program_packet.json");
    const packet = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
    packet.tickets[0].review_artifacts = [{ path: "intake/blocked_ticket.json", kind: "program_intake_packet" }];
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");

    const intakeDir = join(tmp, "intake");
    const fsLib = await import("fs");
    fsLib.mkdirSync(intakeDir, { recursive: true });
    fsLib.writeFileSync(join(intakeDir, "blocked_ticket.json"), JSON.stringify({
      ticket_intake_receipt: {
        deterministic_status: "blocked",
        deepseek_advisory_status: "blocked",
        deepseek_advisory_block: [
          "<<<DEEPSEEK_VERDICT_BEGIN>>>",
          "Status: blocked",
          "Recommended actions:",
          "- Link stories to the ticket with story-bootstrap.",
          "- Add verification evidence for ripple_check, migration-bootstrap, and transition-gate-flows.",
          "<<<DEEPSEEK_VERDICT_END>>>",
        ].join("\n"),
      },
    }, null, 2));

    const dryRun = run(["check", "--program", packetPath, "--remediate", "--json"], tmp);
    const dryTasks = dryRun.parsed?.remediation?.tasks || [];
    assert(dryRun.ok && dryRun.parsed?.remediation?.task_count === 2, "--remediate dry-run extracts blocked advisory actions");
    assert(dryTasks.some((task) => task.workflow === "/story-bootstrap" && task.spawn_status === "dry_run_only"), "--remediate classifies story action as story-bootstrap dry-run");
    assert(dryTasks.some((task) => task.workflow === "/safe-change-power" && task.kind === "planner_core_proof"), "--remediate classifies proof action as planner-core proof");

    const write = run(["check", "--program", packetPath, "--remediate", "--write", "--json"], tmp);
    const artifactPath = write.parsed?.remediation?.artifact_path;
    const fullArtifactPath = artifactPath ? join(tmp, artifactPath) : null;
    assert(write.ok && artifactPath && existsSync(fullArtifactPath), "--remediate --write records a remediation task packet");
    const written = JSON.parse(readFileSync(fullArtifactPath, "utf-8"));
    assert(written.tasks.every((task) => task.spawn_status === "task_packet_written"), "--remediate --write marks tasks as written packets");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// T-INTAKE-D451770E closure: --auto-story dry-run + dedup behavior.
// Uses PLANNER_SUPERVISOR_MOCK_RESPONSE / PLANNER_SUPERVISOR_MOCK_ERROR to
// control the LLM advisory deterministically — no live API calls.
{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-auto-story-"));
  try {
    const init = run(["init", "--program", "auto-story", "--remote-mode", "local-only", "--json"], tmp);
    const packetPath = join(tmp, "plans", "programs", "auto-story", "program_packet.json");
    assert(init.ok && existsSync(packetPath), "auto-story fixture initializes a packet");
    const registryPath = join(tmp, "reports", "user_story_audit", "story_registry.json");
    const fsLib = await import("fs");
    fsLib.mkdirSync(dirname(registryPath), { recursive: true });
    fsLib.writeFileSync(registryPath, JSON.stringify({ updated: "2026-05-30T00:00:00Z", stories: [], consolidations: [] }, null, 2));

    // Scenario A: --auto-story with mock LLM error -> deterministic fallback path, advisory.available === false
    const failOpen = run([
      "intake",
      "--program", packetPath,
      "--from-text", "Add a Program Manager auto-story feature that drafts review-needed stories",
      "--auto-story",
      "--write",
      "--json",
    ], tmp, { PLANNER_SUPERVISOR_MOCK_ERROR: "timeout" });
    assert(failOpen.ok && failOpen.parsed?.auto_story?.enabled === true, "--auto-story emits auto_story.enabled=true");
    assert(failOpen.parsed?.auto_story?.advisory?.available === false, "--auto-story fails open when LLM unreachable (mocked error)");
    assert(Array.isArray(failOpen.parsed?.auto_story?.stories), "--auto-story produces a stories array even on fail-open");

    // Scenario B: --auto-story with a successful mock LLM -> story written to registry
    fsLib.writeFileSync(registryPath, JSON.stringify({ updated: "2026-05-30T00:00:00Z", stories: [], consolidations: [] }, null, 2));
    const mockStories = JSON.stringify({
      story_candidates: [
        {
          title: "Auto-story drafting from intake",
          user: "program operator",
          need: "Draft review-needed stories from intake text",
          outcome: "Program tickets carry traceable story refs without manual edits",
          acceptance_criteria: ["Draft stories are marked NOT_IMPLEMENTED", "Dedup prevents duplicate appends"],
          tags: ["program_manager"],
        },
      ],
    });
    const happyPath = run([
      "intake",
      "--program", packetPath,
      "--from-text", "Add a Program Manager auto-story feature that drafts review-needed stories",
      "--auto-story",
      "--write",
      "--json",
    ], tmp, { PLANNER_SUPERVISOR_MOCK_RESPONSE: mockStories });
    assert(happyPath.ok && (happyPath.parsed?.auto_story?.story_refs || []).length >= 1, "--auto-story mock LLM produces at least one story ref");
    const updatedRegistry = JSON.parse(fsLib.readFileSync(registryPath, "utf-8"));
    assert(updatedRegistry.stories.length >= 1, "--auto-story writes draft story into story_registry.json");
    const draftStory = updatedRegistry.stories[0];
    assert(draftStory?.status === "NOT_IMPLEMENTED" && (draftStory?.tags || []).includes("draft"), "--auto-story marks drafts as NOT_IMPLEMENTED + draft tag");
    assert(/^US-PM-AUTO-H[0-9A-F]{16}$/.test(draftStory?.id || ""), "--auto-story writes content-hash story ids");

    // Scenario C: re-run with identical text + mock should NOT duplicate
    const beforeCount = updatedRegistry.stories.length;
    const repeat = run([
      "intake",
      "--program", packetPath,
      "--from-text", "Add a Program Manager auto-story feature that drafts review-needed stories",
      "--auto-story",
      "--write",
      "--json",
    ], tmp, { PLANNER_SUPERVISOR_MOCK_RESPONSE: mockStories });
    assert(repeat.ok, "--auto-story repeat invocation succeeds");
    const finalRegistry = JSON.parse(fsLib.readFileSync(registryPath, "utf-8"));
    assert(finalRegistry.stories.length === beforeCount, "--auto-story dedups via source_hash on repeat invocation");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// R4 collision guard: two isolated roots with the same registry snapshot must not
// allocate the same new auto-story id.
{
  const rootA = mkdtempSync(join(tmpdir(), "program-manager-story-collision-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "program-manager-story-collision-b-"));
  const roots = [rootA, rootB];
  try {
    for (const root of roots) {
      const init = run(["init", "--program", "collision-proof", "--remote-mode", "local-only", "--json"], root);
      assert(init.ok, "collision fixture initializes a Program Packet root");
      const registryPath = join(root, "reports", "user_story_audit", "story_registry.json");
      mkdirSync(dirname(registryPath), { recursive: true });
      writeFileSync(registryPath, JSON.stringify({
        version: 1,
        updated: "2026-07-04T00:00:00.000Z",
        stories: [
          {
            id: "US-PM-AUTO-231",
            title: "Legacy numeric R4 story",
            status: "NOT_IMPLEMENTED",
            tags: ["program_manager"],
          },
        ],
        consolidations: [],
      }, null, 2));
    }

    const packetA = join(rootA, "plans", "programs", "collision-proof", "program_packet.json");
    const packetB = join(rootB, "plans", "programs", "collision-proof", "program_packet.json");
    const mockA = JSON.stringify({
      story_candidates: [{
        title: "Parallel branch alpha story",
        user: "program operator",
        need: "allocate story ids without branch-local collision",
        outcome: "alpha intake gets a stable id",
        acceptance_criteria: ["alpha id is stable"],
        tags: ["program_manager"],
      }],
    });
    const mockB = JSON.stringify({
      story_candidates: [{
        title: "Parallel branch beta story",
        user: "program operator",
        need: "allocate story ids without branch-local collision",
        outcome: "beta intake gets a stable id",
        acceptance_criteria: ["beta id is stable"],
        tags: ["program_manager"],
      }],
    });

    const intakeA = run([
      "intake",
      "--program", packetA,
      "--from-text", "Parallel branch alpha intake allocates an R4 story",
      "--auto-story",
      "--write",
      "--json",
    ], rootA, { PLANNER_SUPERVISOR_MOCK_RESPONSE: mockA });
    const intakeB = run([
      "intake",
      "--program", packetB,
      "--from-text", "Parallel branch beta intake allocates an R4 story",
      "--auto-story",
      "--write",
      "--json",
    ], rootB, { PLANNER_SUPERVISOR_MOCK_RESPONSE: mockB });

    const idA = intakeA.parsed?.auto_story?.story_refs?.[0];
    const idB = intakeB.parsed?.auto_story?.story_refs?.[0];
    assert(intakeA.ok && intakeB.ok, "parallel isolated auto-story intakes succeed");
    assert(/^US-PM-AUTO-H[0-9A-F]{16}$/.test(idA || ""), "first isolated intake uses hash story id");
    assert(/^US-PM-AUTO-H[0-9A-F]{16}$/.test(idB || ""), "second isolated intake uses hash story id");
    assert(idA && idB && idA !== idB, "parallel isolated intakes do not collide");
    const registryA = JSON.parse(readFileSync(join(rootA, "reports", "user_story_audit", "story_registry.json"), "utf-8"));
    assert(registryA.stories.some((story) => story.id === "US-PM-AUTO-231"), "legacy numeric auto-story id remains valid in registry");
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

// T-INTAKE-7132C8C3 closure: summarizeLongTitle threshold + override + deterministic fallback.
{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-title-summary-"));
  try {
    const init = run(["init", "--program", "title-summary", "--remote-mode", "local-only", "--json"], tmp);
    const packetPath = join(tmp, "plans", "programs", "title-summary", "program_packet.json");
    assert(init.ok && existsSync(packetPath), "title-summary fixture initializes a packet");
    const fsLib = await import("fs");

    // Scenario A: short title (< 70 chars) -> no summarization triggered
    const shortText = "Add a Program Manager flag for short titles. Short and clear.";
    const short = run([
      "intake",
      "--program", packetPath,
      "--from-text", shortText,
      "--write",
      "--json",
    ], tmp);
    const shortTitleSource = short.parsed?.intake_packet?.source?.title_source;
    assert(short.ok && shortTitleSource && shortTitleSource !== "llm_summary" && shortTitleSource !== "deterministic_summary", "short title does not trigger summarization");

    // Scenario B: long title (> 70 chars) + LLM mocked error -> deterministic_summary path
    const longText = "Add a Program Manager that handles arbitrarily long intake text without crashing or producing chopped truncated titles for the operator to manually rewrite later when triaging the backlog";
    const longFallback = run([
      "intake",
      "--program", packetPath,
      "--from-text", longText,
      "--write",
      "--json",
    ], tmp, { PLANNER_SUPERVISOR_MOCK_ERROR: "timeout" });
    const fallbackTitleSource = longFallback.parsed?.intake_packet?.source?.title_source;
    const fallbackTitle = longFallback.parsed?.intake_packet?.source?.title;
    assert(longFallback.ok && fallbackTitleSource === "deterministic_summary", "long title without LLM uses deterministic_summary fallback");
    assert(fallbackTitle && fallbackTitle.length <= 70 && !fallbackTitle.endsWith("..."), "deterministic fallback title is concise and does not end with ellipsis");

    // Scenario C: long title with explicit --title -> override wins; no summarization
    const override = run([
      "intake",
      "--program", packetPath,
      "--from-text", longText,
      "--title", "Explicit Override Title",
      "--write",
      "--json",
    ], tmp);
    const overrideTitleSource = override.parsed?.intake_packet?.source?.title_source;
    const overrideTitle = override.parsed?.intake_packet?.source?.title;
    assert(override.ok && overrideTitle === "Explicit Override Title", "--title explicit override is preserved");
    assert(overrideTitleSource !== "llm_summary" && overrideTitleSource !== "deterministic_summary", "--title override skips summarization entirely");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// T-INTAKE-35113C56 closure: disposition is dry-run by default, evidence-gated,
// partial-write safe, and idempotent for already applied packet state.
{
  function runGit(tmp, args) {
    return execFileSync("git", args, { cwd: tmp, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  }

  function writeJson(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  }

  function ticket(id, lifecycle, { title = id, externalRefs = true, childPlan = "plans/plan_valid", deferred = false, awaitingExternalAction } = {}) {
    return {
      id,
      epic_id: "EP-DISP",
      title,
      type: "refactor",
      ticket_type: "code_refactor",
      lifecycle,
      review_status: "not_run",
      story_refs: ["US-DISP"],
      defect_refs: [],
      gap_refs: [],
      depends_on: [],
      acceptance_criteria: [`AC-${id}`],
      child_plan: {
        policy: "required",
        plan_dir: childPlan,
        reason: "Disposition fixture child plan.",
      },
      compatibility_contract_refs: [],
      migration_boundary_refs: [],
      deletion_move_census_refs: [],
      verification_refs: [`VM-${id}`],
      ...(externalRefs ? {
        external_refs: [{
          kind: "github_issue",
          repo: "owner/repo",
          issue_number: id.endsWith("VALID") ? 101 : 102,
          url: `https://github.com/owner/repo/issues/${id.endsWith("VALID") ? 101 : 102}`,
        }],
      } : { external_refs: [] }),
      ...(deferred ? {
        close_reason: "Superseded by fixture portfolio decision.",
        deferral_decision_ref: "D-DISP",
      } : {}),
      ...(awaitingExternalAction !== undefined ? { awaiting_external_action: awaitingExternalAction } : {}),
      persona_review: {
        version: 1,
        status: "needs_evidence",
        findings: [{ id: "PR-001", status: "needs_verification", evidence_refs: [] }],
      },
    };
  }

  function row(id) {
    return {
      id: `VM-${id}`,
      scope: "ticket",
      subject_ref: id,
      acceptance_criterion_ref: `AC-${id}`,
      proof_type: "proof:artifact_review",
      command_or_action: "Review fixture receipt.",
      pass_means: "Disposition fixture passes.",
    };
  }

  function criterion(id) {
    return {
      id: `AC-${id}`,
      scope: "ticket",
      subject_ref: id,
      text: `Disposition fixture acceptance for ${id}.`,
      story_refs: ["US-DISP"],
      maintenance_rationale: null,
    };
  }

  const tmp = mkdtempSync(join(tmpdir(), "program-manager-disposition-"));
  try {
    runGit(tmp, ["init"]);
    writeFileSync(join(tmp, "evidence.txt"), "fixture evidence\n", "utf-8");
    runGit(tmp, ["add", "evidence.txt"]);
    runGit(tmp, ["-c", "user.name=Planner Test", "-c", "user.email=planner-test@example.com", "commit", "-m", "T-DISP-VALID T-DISP-LEGACY T-DISP-NESTED T-DISP-BAD T-DISP-MALFORMED T-DISP-MARKDOWN disposition fixture evidence"]);
    const commitHash = runGit(tmp, ["rev-parse", "HEAD"]);

    const planDir = join(tmp, "plans", "plan_valid");
    mkdirSync(planDir, { recursive: true });
    writeJson(join(planDir, "state.json"), { state: "CLOSE", goal: "T-DISP-VALID T-DISP-BAD disposition fixture child plan" });
    writeJson(join(planDir, "scope.json"), {
      declared_files: ["src/disposition_delivery.mjs", "tests/disposition_delivery.test.mjs"],
      owned_files: ["src/disposition_delivery.mjs", "tests/disposition_delivery.test.mjs"],
    });
    writeFileSync(join(planDir, "summary.md"), "T-DISP-MARKDOWN appears only in canonical Markdown, not state.goal.\n", "utf-8");
    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(join(tmp, "tests"), { recursive: true });
    writeFileSync(join(tmp, "src", "disposition_delivery.mjs"), "export const dispositionDelivery = true;\n", "utf-8");
    writeFileSync(join(tmp, "tests", "disposition_delivery.test.mjs"), "export const dispositionProof = true;\n", "utf-8");
    runGit(tmp, ["add", "plans/plan_valid", "src/disposition_delivery.mjs", "tests/disposition_delivery.test.mjs"]);
    runGit(tmp, ["-c", "user.name=Planner Test", "-c", "user.email=planner-test@example.com", "commit", "-m", "ship complete disposition delivery scope"]);
    const scopeCommitHash = runGit(tmp, ["rev-parse", "HEAD"]);

    const nestedPlanRel = "plans/programs/disp/child_plans/nested_supported";
    const nestedPlanDir = join(tmp, nestedPlanRel);
    mkdirSync(nestedPlanDir, { recursive: true });
    writeJson(join(nestedPlanDir, "state.json"), { state: "CLOSE", goal: "Supported nested Program child plan" });
    writeJson(join(nestedPlanDir, "scope.json"), {
      declared_files: ["src/disposition_delivery.mjs"],
      owned_files: ["src/disposition_delivery.mjs"],
    });

    const unsupportedDeclaredDir = join(tmp, "plans", "nested", "plan_declared");
    mkdirSync(unsupportedDeclaredDir, { recursive: true });
    writeJson(join(unsupportedDeclaredDir, "state.json"), { state: "CLOSE", goal: "Existing but unsupported nested plan" });
    writeJson(join(unsupportedDeclaredDir, "scope.json"), { declared_files: ["src/disposition_delivery.mjs"] });

    const malformedPlanDir = join(tmp, "plans", "plan_malformed");
    mkdirSync(malformedPlanDir, { recursive: true });
    writeFileSync(join(malformedPlanDir, "state.json"), "{ malformed state\n", "utf-8");
    writeFileSync(join(malformedPlanDir, "summary.md"), "T-DISP-MALFORMED is closed according to an untrusted packet summary.\n", "utf-8");

    const matchedReceiptRel = "reports/ive/push_receipts/t-disp-valid.json";
    const matchedReceiptPath = join(tmp, matchedReceiptRel);
    const matchedReceipt = {
      schema_version: "ive.push_receipt.v1",
      ticket_id: "T-DISP-VALID",
      status: "PASS",
    };
    const validAwaitingExternalAction = {
      kind: "operator_run",
      reason: "Wait for the governed fixture receipt before closing.",
      expected_evidence: {
        type: "json_match",
        root: "reports/ive/push_receipts",
        match: { ...matchedReceipt },
      },
      recorded_at: "2026-07-18T10:15:05.000Z",
    };
    writeJson(matchedReceiptPath, matchedReceipt);

    const packetPath = join(tmp, "plans", "programs", "disp", "program_packet.json");
    const packet = {
      version: 1,
      id: "PGM-DISP",
      title: "Disposition fixture",
      status: "executing",
      goal: "Exercise deterministic backlog disposition.",
      remote_mode: "local-only",
      story_refs: ["US-DISP"],
      epics: [{
        id: "EP-DISP",
        title: "Disposition",
        story_refs: ["US-DISP"],
        ticket_refs: ["T-DISP-VALID", "T-DISP-LEGACY", "T-DISP-NESTED", "T-DISP-SCOPE", "T-DISP-BAD", "T-DISP-MALFORMED", "T-DISP-DEFER"],
      }],
      tickets: [
        ticket("T-DISP-VALID", "in_progress", {
          title: "Valid shipped-open closure",
          awaitingExternalAction: validAwaitingExternalAction,
        }),
        ticket("T-DISP-LEGACY", "in_progress", { title: "Legacy shipped-open closure without external wait", childPlan: "plan_valid" }),
        ticket("T-DISP-NESTED", "in_progress", { title: "Supported nested child-plan closure", childPlan: nestedPlanRel }),
        ticket("T-DISP-SCOPE", "in_progress", { title: "No-ID full-scope shipped-open closure" }),
        ticket("T-DISP-BAD", "proposed", { title: "Invalid shipped-open closure", childPlan: "plans/nested/plan_declared" }),
        ticket("T-DISP-MALFORMED", "proposed", { title: "Malformed-state shipped-open closure", childPlan: "plans/plan_malformed" }),
        ticket("T-DISP-DEFER", "deferred", { title: "Deferred obsolete fixture", deferred: true, externalRefs: false, childPlan: null }),
      ],
      acceptance_criteria: ["T-DISP-VALID", "T-DISP-LEGACY", "T-DISP-NESTED", "T-DISP-SCOPE", "T-DISP-BAD", "T-DISP-MALFORMED", "T-DISP-DEFER"].map(criterion),
      dependencies: [],
      compatibility_contracts: [],
      migration_boundaries: [],
      deletion_move_census: [],
      verification_matrix: ["T-DISP-VALID", "T-DISP-LEGACY", "T-DISP-NESTED", "T-DISP-SCOPE", "T-DISP-BAD", "T-DISP-MALFORMED", "T-DISP-DEFER"].map(row),
      decisions: [],
    };
    packet.tickets.find((entry) => entry.id === "T-DISP-VALID").external_refs = [];
    writeJson(packetPath, packet);

    const repairPath = join(tmp, "reports", "ive", "lifecycle_reconciliation", "fixture_repair.json");
    writeJson(repairPath, {
      findings: {
        shipped_open: [
          {
            id: "lifecycle:T-DISP-VALID",
            ticket_id: "T-DISP-VALID",
            ticket_title: "Valid shipped-open closure",
            program_id: "PGM-DISP",
            packet_path: "plans/programs/disp/program_packet.json",
            current_lifecycle: "in_progress",
            proposed_lifecycle: "closed",
            awaiting_external_action: {
              status: "expired",
              matched_path: matchedReceiptRel,
            },
            evidence_chain: [
              {
                kind: "expected_external_evidence",
                status: "matched",
                path: matchedReceiptRel,
                detail: "Declared awaiting_external_action evidence now exists; exemption expired.",
              },
              {
                kind: "declared_child_plan",
                status: "closed",
                path: "plans/plan_valid",
                state_path: "plans/plan_valid/state.json",
                detail: "Declared child_plan.plan_dir is close.",
                closes_lifecycle: true,
              },
              {
                kind: "git_commit",
                status: "supporting",
                commit: commitHash.slice(0, 8),
                hash: commitHash,
                subject: "Disposition fixture evidence",
              },
            ],
          },
          {
            id: "lifecycle:T-DISP-LEGACY",
            ticket_id: "T-DISP-LEGACY",
            ticket_title: "Legacy shipped-open closure without external wait",
            program_id: "PGM-DISP",
            packet_path: "plans/programs/disp/program_packet.json",
            current_lifecycle: "in_progress",
            proposed_lifecycle: "closed",
            evidence_chain: [
              {
                kind: "declared_child_plan",
                status: "closed",
                path: "plans/plan_valid",
                state_path: "plans/plan_valid/state.json",
                detail: "Declared child_plan.plan_dir is close.",
                closes_lifecycle: true,
              },
              {
                kind: "git_commit",
                status: "supporting",
                commit: commitHash.slice(0, 8),
                hash: commitHash,
                subject: "Disposition fixture evidence",
              },
            ],
          },
          {
            id: "lifecycle:T-DISP-NESTED",
            ticket_id: "T-DISP-NESTED",
            ticket_title: "Supported nested child-plan closure",
            program_id: "PGM-DISP",
            packet_path: "plans/programs/disp/program_packet.json",
            current_lifecycle: "in_progress",
            proposed_lifecycle: "closed",
            evidence_chain: [
              {
                kind: "declared_child_plan",
                status: "closed",
                path: nestedPlanRel,
                state_path: `${nestedPlanRel}/state.json`,
                detail: "Supported nested declared child plan is closed.",
                closes_lifecycle: true,
              },
              {
                kind: "git_commit",
                status: "supporting",
                commit: commitHash.slice(0, 8),
                hash: commitHash,
                subject: "Disposition fixture evidence",
              },
            ],
          },
          {
            id: "lifecycle:T-DISP-SCOPE",
            ticket_id: "T-DISP-SCOPE",
            ticket_title: "No-ID full-scope shipped-open closure",
            program_id: "PGM-DISP",
            packet_path: "plans/programs/disp/program_packet.json",
            current_lifecycle: "in_progress",
            proposed_lifecycle: "closed",
            evidence_chain: [
              {
                kind: "declared_child_plan",
                status: "closed",
                path: "plans/plan_valid",
                state_path: "plans/plan_valid/state.json",
                summary_path: "reports/forged-summary.md",
                detail: "Packet claims the declared child plan is close.",
                closes_lifecycle: true,
              },
              {
                kind: "git_commit",
                status: "supporting",
                commit: scopeCommitHash.slice(0, 8),
                hash: scopeCommitHash,
                subject: "Packet claims a full-scope delivery commit.",
              },
            ],
          },
          {
            id: "lifecycle:T-DISP-BAD",
            ticket_id: "T-DISP-BAD",
            ticket_title: "Invalid shipped-open closure",
            program_id: "PGM-DISP",
            packet_path: "plans/programs/disp/program_packet.json",
            current_lifecycle: "proposed",
            proposed_lifecycle: "closed",
            evidence_chain: [
              {
                kind: "closed_plan_match",
                status: "closed",
                path: "plans/plan_valid",
                state_path: "plans/plan_valid/state.json",
                summary_path: "plans/plan_valid/summary.md",
                detail: "Closed plan goal references T-DISP-BAD.",
                closes_lifecycle: true,
              },
              {
                kind: "git_commit",
                status: "supporting",
                commit: commitHash.slice(0, 8),
                hash: commitHash,
                subject: "Forged subject claims missing ticket evidence",
              },
            ],
          },
          {
            id: "lifecycle:T-DISP-MALFORMED",
            ticket_id: "T-DISP-MALFORMED",
            ticket_title: "Malformed-state shipped-open closure",
            program_id: "PGM-DISP",
            packet_path: "plans/programs/disp/program_packet.json",
            current_lifecycle: "proposed",
            proposed_lifecycle: "closed",
            evidence_chain: [
              {
                kind: "declared_child_plan",
                status: "closed",
                path: "plans/plan_malformed",
                state_path: "plans/plan_valid/state.json",
                summary_path: "plans/plan_malformed/summary.md",
                detail: "Packet status and summary claim a close despite malformed canonical state.",
                closes_lifecycle: true,
              },
              {
                kind: "git_commit",
                status: "supporting",
                commit: commitHash.slice(0, 8),
                hash: commitHash,
                subject: "Packet claims exact-ID evidence.",
              },
            ],
          },
        ],
        duplicate_scope: [{
          ticket_id: "T-DISP-BAD",
          ticket_title: "Invalid shipped-open closure",
          program_id: "PGM-DISP",
          packet_path: "plans/programs/disp/program_packet.json",
          matched_scope: {
            kind: "decision",
            id: "D-DISP",
            title: "Fixture consolidation decision",
            program_id: "PGM-DISP",
            packet_path: "plans/programs/disp/program_packet.json",
          },
        }],
      },
    });

    function scopedDispositionFixture(suffix, mutateRepair = (value) => value) {
      const programId = `PGM-DISP-${suffix.toUpperCase()}`;
      const packetRel = `plans/programs/disp-${suffix}/program_packet.json`;
      const scopedPacketPath = join(tmp, packetRel);
      const scopedPacket = structuredClone(packet);
      scopedPacket.id = programId;
      writeJson(scopedPacketPath, scopedPacket);

      const scopedRepair = JSON.parse(readFileSync(repairPath, "utf-8"));
      for (const finding of [
        ...(scopedRepair.findings?.shipped_open || []),
        ...(scopedRepair.findings?.duplicate_scope || []),
      ]) {
        finding.program_id = programId;
        finding.packet_path = packetRel;
      }
      mutateRepair(scopedRepair);
      const scopedRepairPath = join(tmp, "reports", "ive", "lifecycle_reconciliation", `fixture_repair_${suffix}.json`);
      writeJson(scopedRepairPath, scopedRepair);
      return { packetPath: scopedPacketPath, repairPath: scopedRepairPath };
    }

    const remoteSyncPacketPath = join(tmp, "plans", "programs", "disp-sync", "program_packet.json");
    const remoteSyncPacket = {
      ...packet,
      id: "PGM-DISP-SYNC",
      remote_mode: "remote-sync",
      remote_policy: { repository_slug: "owner/repo" },
      epics: [{
        ...packet.epics[0],
        ticket_refs: ["T-DISP-VALID"],
      }],
      tickets: [
        ticket("T-DISP-VALID", "in_progress", { title: "Remote-sync mirrorless closure", externalRefs: false }),
      ],
      acceptance_criteria: ["T-DISP-VALID"].map(criterion),
      verification_matrix: ["T-DISP-VALID"].map(row),
    };
    writeJson(remoteSyncPacketPath, remoteSyncPacket);
    const remoteSyncRepairPath = join(tmp, "reports", "ive", "lifecycle_reconciliation", "fixture_repair_remote_sync.json");
    writeJson(remoteSyncRepairPath, {
      findings: {
        shipped_open: [{
          id: "lifecycle:T-DISP-VALID",
          ticket_id: "T-DISP-VALID",
          ticket_title: "Remote-sync mirrorless closure",
          program_id: "PGM-DISP-SYNC",
          packet_path: "plans/programs/disp-sync/program_packet.json",
          current_lifecycle: "in_progress",
          proposed_lifecycle: "closed",
          evidence_chain: [
            {
              kind: "declared_child_plan",
              status: "closed",
              path: "plans/plan_valid",
              state_path: "plans/plan_valid/state.json",
              detail: "Declared child_plan.plan_dir is close.",
              closes_lifecycle: true,
            },
            {
              kind: "git_commit",
              status: "supporting",
              commit: commitHash.slice(0, 8),
              hash: commitHash,
              subject: "Disposition fixture evidence",
            },
          ],
        }],
      },
    });
    const remoteSyncDryRun = run([
      "disposition",
      "--from-repair-packet", remoteSyncRepairPath,
      "--json",
    ], tmp);
    assert(!remoteSyncDryRun.ok && remoteSyncDryRun.parsed?.shipped_open?.[0]?.blockers?.includes("missing_github_issue_mirror"), "remote-sync shipped-open disposition still requires GitHub issue mirror");

    const bareFindingFixture = scopedDispositionFixture("bare-finding-filter");
    const bareFindingBefore = readFileSync(bareFindingFixture.packetPath);
    const bareFindingReceiptPath = join(tmp, "reports", "ive", "lifecycle_dispositions", "fixture_bare_finding_filter_receipt.json");
    const bareFinding = run([
      "disposition",
      "--from-repair-packet", bareFindingFixture.repairPath,
      "--output", bareFindingReceiptPath,
      "--write",
      "--json",
      "--finding",
    ], tmp);
    assert(!bareFinding.ok && bareFinding.parsed?.status === "FAIL" && /finding.*(?:missing|requires).*value/i.test(bareFinding.parsed?.error || ""), "disposition rejects a value-less --finding selector before bulk fallback");
    assert(bareFindingBefore.equals(readFileSync(bareFindingFixture.packetPath)) && !existsSync(bareFindingReceiptPath), "value-less disposition --finding leaves packet bytes unchanged and writes no receipt");

    const missingFixture = scopedDispositionFixture("missing-filter");
    const missingBefore = readFileSync(missingFixture.packetPath);
    const missingReceiptPath = join(tmp, "reports", "ive", "lifecycle_dispositions", "fixture_missing_filter_receipt.json");
    const missing = run([
      "disposition",
      "--from-repair-packet", missingFixture.repairPath,
      "--finding", "lifecycle:T-DISP-MISSING",
      "--output", missingReceiptPath,
      "--write",
      "--json",
    ], tmp);
    assert(!missing.ok && missing.parsed?.status === "FAIL" && /finding.*not found/i.test(missing.parsed?.error || ""), "disposition --finding fails closed when the exact repair finding does not exist");
    assert(missingBefore.equals(readFileSync(missingFixture.packetPath)) && !existsSync(missingReceiptPath), "missing disposition finding leaves packet bytes unchanged and writes no receipt");

    const selectedFixture = scopedDispositionFixture("selected-filter");
    const selectedBefore = readFileSync(selectedFixture.packetPath);
    const selectedBeforePacket = JSON.parse(selectedBefore.toString("utf-8"));
    const siblingBefore = Buffer.from(JSON.stringify(selectedBeforePacket.tickets.find((entry) => entry.id === "T-DISP-LEGACY")));
    const selectedDryRun = run([
      "disposition",
      "--from-repair-packet", selectedFixture.repairPath,
      "--finding", "lifecycle:T-DISP-VALID",
      "--json",
    ], tmp);
    const selectedDryEntry = selectedDryRun.parsed?.shipped_open?.[0];
    assert(selectedDryRun.ok && selectedDryRun.parsed?.status === "PASS", "disposition --finding dry-run evaluates only the selected valid repair finding");
    assert(selectedDryRun.parsed?.finding_id === "lifecycle:T-DISP-VALID" && selectedDryRun.parsed?.shipped_open?.length === 1 && selectedDryRun.parsed?.duplicate_scope?.length === 0, "disposition --finding dry-run records one exact repair finding in its receipt");
    assert(selectedDryEntry?.ticket_id === "T-DISP-VALID" && selectedDryEntry?.action === "would_apply_closed", "disposition --finding dry-run reports the selected ticket would close");
    assert(selectedBefore.equals(readFileSync(selectedFixture.packetPath)), "selected disposition dry-run leaves Program Packet bytes unchanged");

    const selectedReceiptPath = join(tmp, "reports", "ive", "lifecycle_dispositions", "fixture_selected_filter_receipt.json");
    const selectedWrite = run([
      "disposition",
      "--from-repair-packet", selectedFixture.repairPath,
      "--finding", "lifecycle:T-DISP-VALID",
      "--output", selectedReceiptPath,
      "--write",
      "--json",
    ], tmp);
    const selectedWrittenPacket = JSON.parse(readFileSync(selectedFixture.packetPath, "utf-8"));
    const selectedWriteEntry = selectedWrite.parsed?.shipped_open?.[0];
    const siblingAfter = Buffer.from(JSON.stringify(selectedWrittenPacket.tickets.find((entry) => entry.id === "T-DISP-LEGACY")));
    assert(selectedWrite.ok && selectedWrite.parsed?.status === "PASS" && selectedWrite.parsed?.receipt_written === true && existsSync(selectedReceiptPath), "disposition --finding write persists one passing scoped receipt");
    assert(selectedWrite.parsed?.shipped_open?.length === 1 && selectedWrite.parsed?.duplicate_scope?.length === 0 && selectedWriteEntry?.ticket_id === "T-DISP-VALID" && selectedWriteEntry?.action === "applied_closed", "disposition --finding write applies only the selected repair finding");
    assert(selectedWrittenPacket.tickets.find((entry) => entry.id === "T-DISP-VALID")?.lifecycle === "closed", "disposition --finding write closes the selected ticket");
    assert(siblingBefore.equals(siblingAfter), "disposition --finding write preserves the sibling ticket byte-for-byte");
    assert(JSON.stringify(selectedDryEntry?.verification) === JSON.stringify(selectedWriteEntry?.verification), "disposition --finding dry-run and write use identical verification evidence");
    assert(JSON.stringify(selectedWrite.parsed?.packet_writes?.[0]?.changed_ticket_ids) === JSON.stringify(["T-DISP-VALID"]), "disposition --finding packet receipt names only the selected changed ticket");

    const ambiguousFixture = scopedDispositionFixture("ambiguous-filter", (scopedRepair) => {
      scopedRepair.findings.duplicate_scope[0].id = "lifecycle:T-DISP-VALID";
    });
    const ambiguousBefore = readFileSync(ambiguousFixture.packetPath);
    const ambiguousReceiptPath = join(tmp, "reports", "ive", "lifecycle_dispositions", "fixture_ambiguous_filter_receipt.json");
    const ambiguous = run([
      "disposition",
      "--from-repair-packet", ambiguousFixture.repairPath,
      "--finding", "lifecycle:T-DISP-VALID",
      "--output", ambiguousReceiptPath,
      "--write",
      "--json",
    ], tmp);
    assert(!ambiguous.ok && ambiguous.parsed?.status === "FAIL" && /finding.*ambiguous/i.test(ambiguous.parsed?.error || ""), "disposition --finding rejects an ambiguous repair finding id");
    assert(ambiguousBefore.equals(readFileSync(ambiguousFixture.packetPath)) && !existsSync(ambiguousReceiptPath), "ambiguous disposition finding leaves packet bytes unchanged and writes no receipt");

    const beforeDryRun = readFileSync(packetPath, "utf-8");
    const dryRun = run([
      "disposition",
      "--from-repair-packet", repairPath,
      "--deferred-program", packetPath,
      "--json",
    ], tmp);
    assert(!dryRun.ok && dryRun.parsed?.status === "BLOCKED", "disposition dry-run returns BLOCKED when one shipped-open finding lacks evidence");
    assert(dryRun.parsed?.shipped_open?.find((entry) => entry.ticket_id === "T-DISP-VALID")?.action === "would_apply_closed", "dry-run reports valid shipped-open ticket would close");
    assert(dryRun.parsed?.shipped_open?.find((entry) => entry.ticket_id === "T-DISP-VALID")?.verification?.awaiting_external_action_resolution?.status === "pass", "dry-run validates the matched external-action resolution candidate");
    assert(dryRun.parsed?.shipped_open?.find((entry) => entry.ticket_id === "T-DISP-LEGACY")?.action === "would_apply_closed", "dry-run canonicalizes a supported bare declared child-plan reference");
    assert(dryRun.parsed?.shipped_open?.find((entry) => entry.ticket_id === "T-DISP-NESTED")?.action === "would_apply_closed", "dry-run accepts the supported nested Program child-plan shape");
    assert(dryRun.parsed?.shipped_open?.find((entry) => entry.ticket_id === "T-DISP-SCOPE")?.action === "would_apply_closed", "dry-run accepts a canonical no-ID full-scope commit through the writer path");
    assert(dryRun.parsed?.shipped_open?.find((entry) => entry.ticket_id === "T-DISP-SCOPE")?.verification?.commit_checks?.some((check) => check.linkage_reason === "full_delivery_scope"), "writer verification records the independent full-scope linkage mode");
    assert(dryRun.parsed?.packet_writes?.find((entry) => entry.packet_path === "plans/programs/disp/program_packet.json")?.post_error_count === 0, "dry-run validates the same proposed Program Packet shape as write");
    assert(dryRun.parsed?.shipped_open?.find((entry) => entry.ticket_id === "T-DISP-VALID")?.verification?.checks?.find((check) => check.name === "github_issue_mirror")?.pass === true, "local-only shipped-open disposition does not require GitHub issue mirror");
    assert(dryRun.parsed?.shipped_open?.find((entry) => entry.ticket_id === "T-DISP-BAD")?.blockers?.includes("child_plan_closed"), "dry-run rejects a packet plan that differs from the canonicalized bare declared child path");
    assert(dryRun.parsed?.shipped_open?.find((entry) => entry.ticket_id === "T-DISP-BAD")?.blockers?.includes("scope_match"), "wrong-plan packet prose cannot override an unsupported nonempty declaration");
    assert(dryRun.parsed?.shipped_open?.find((entry) => entry.ticket_id === "T-DISP-BAD")?.verification?.plan_checks?.some((check) => check.diagnostics?.includes("canonical_declared_plan_path_invalid")), "writer surfaces an unsupported nonempty declared plan path diagnostic");
    assert(dryRun.parsed?.shipped_open?.find((entry) => entry.ticket_id === "T-DISP-MALFORMED")?.blockers?.includes("child_plan_closed"), "dry-run rejects packet-supplied status and summary when canonical state JSON is malformed");
    assert(dryRun.parsed?.shipped_open?.find((entry) => entry.ticket_id === "T-DISP-MALFORMED")?.verification?.plan_checks?.some((check) => check.diagnostics?.includes("canonical_state_json_invalid")), "writer receipt surfaces malformed canonical state diagnostics");
    assert(readFileSync(packetPath, "utf-8") === beforeDryRun, "disposition dry-run leaves Program Packet unchanged");

    const receiptPath = join(tmp, "reports", "ive", "lifecycle_dispositions", "fixture_receipt.json");
    const write = run([
      "disposition",
      "--from-repair-packet", repairPath,
      "--deferred-program", packetPath,
      "--output", receiptPath,
      "--write",
      "--json",
    ], tmp);
    const written = JSON.parse(readFileSync(packetPath, "utf-8"));
    const validTicket = written.tickets.find((entry) => entry.id === "T-DISP-VALID");
    const legacyTicket = written.tickets.find((entry) => entry.id === "T-DISP-LEGACY");
    const nestedTicket = written.tickets.find((entry) => entry.id === "T-DISP-NESTED");
    const scopeTicket = written.tickets.find((entry) => entry.id === "T-DISP-SCOPE");
    const badTicket = written.tickets.find((entry) => entry.id === "T-DISP-BAD");
    const malformedTicket = written.tickets.find((entry) => entry.id === "T-DISP-MALFORMED");
    const deferredTicket = written.tickets.find((entry) => entry.id === "T-DISP-DEFER");
    assert(!write.ok && write.parsed?.status === "BLOCKED", "disposition --write can write verified changes while preserving blockers in receipt");
    assert(write.parsed?.receipt_written === true && existsSync(receiptPath), "disposition --write records a receipt artifact");
    assert(validTicket.lifecycle === "closed" && validTicket.review_status === "review_ready", "write closes only the evidence-verified shipped-open ticket");
    assert(!validTicket.awaiting_external_action, "write removes only the evidence-matched expired external-action contract");
    assert(
      JSON.stringify(validTicket.awaiting_external_action_resolved) === JSON.stringify({
        ...validAwaitingExternalAction,
        resolved_at: validTicket.lifecycle_disposition.applied_at,
        resolving_evidence: matchedReceiptRel,
      }),
      "write archives the normalized contract with the exact resolving evidence",
    );
    assert(legacyTicket.lifecycle === "closed" && !legacyTicket.awaiting_external_action_resolved, "write preserves legacy no-wait closure without fabricating an archive");
    assert(nestedTicket.lifecycle === "closed" && nestedTicket.child_plan?.plan_dir === nestedPlanRel, "write closes a supported nested Program child plan without rewriting its declaration");
    assert(scopeTicket.lifecycle === "closed" && scopeTicket.lifecycle_disposition?.commit_linkage === "full_delivery_scope", "write closes the no-ID ticket only from canonical same-commit scope and state proof");
    assert(write.parsed?.packet_writes?.find((entry) => entry.packet_path === "plans/programs/disp/program_packet.json")?.post_error_count === 0, "write persists a schema-valid closed packet after retiring the matched wait");
    assert(validTicket.persona_review?.status === "accepted", "write clears closed-ticket persona evidence blocker");
    assert(written.verification_matrix.find((entry) => entry.id === "VM-T-DISP-VALID")?.result === "pass", "write marks closed ticket verification row passing");
    assert(badTicket.lifecycle === "proposed", "write keeps failed-evidence shipped-open ticket open");
    assert(malformedTicket.lifecycle === "proposed", "write keeps malformed canonical-state ticket open despite forged packet status and summary");
    assert(deferredTicket.backlog_disposition?.classification === "close_obsolete", "write records deterministic deferred ticket classification");

    const isolatedPacketPath = join(tmp, "plans", "programs", "disp-isolated", "program_packet.json");
    const isolatedTicket = ticket("T-DISP-MARKDOWN", "proposed", {
      title: "Markdown-only undeclared-plan association",
      childPlan: null,
    });
    const isolatedPacket = {
      ...packet,
      id: "PGM-DISP-ISOLATED",
      epics: [{
        ...packet.epics[0],
        ticket_refs: [isolatedTicket.id],
      }],
      tickets: [isolatedTicket],
      acceptance_criteria: [criterion(isolatedTicket.id)],
      verification_matrix: [row(isolatedTicket.id)],
    };
    writeJson(isolatedPacketPath, isolatedPacket);
    const isolatedRepairPath = join(tmp, "reports", "ive", "lifecycle_reconciliation", "fixture_repair_markdown_only.json");
    writeJson(isolatedRepairPath, {
      findings: {
        shipped_open: [{
          id: `lifecycle:${isolatedTicket.id}`,
          ticket_id: isolatedTicket.id,
          ticket_title: isolatedTicket.title,
          program_id: isolatedPacket.id,
          packet_path: "plans/programs/disp-isolated/program_packet.json",
          current_lifecycle: "proposed",
          proposed_lifecycle: "closed",
          evidence_chain: [
            {
              kind: "closed_plan_match",
              status: "closed",
              path: "plans/plan_valid",
              state_path: "plans/plan_valid/state.json",
              summary_path: "plans/plan_valid/summary.md",
              detail: "Packet nominates a plan whose Markdown mentions the ticket.",
              closes_lifecycle: true,
            },
            {
              kind: "git_commit",
              status: "supporting",
              commit: commitHash.slice(0, 8),
              hash: commitHash,
              subject: "Exact-ID commit exists independently of plan association.",
            },
          ],
        }],
      },
    });
    const isolatedPacketBefore = readFileSync(isolatedPacketPath, "utf-8");
    const isolatedWrite = run([
      "disposition",
      "--from-repair-packet", isolatedRepairPath,
      "--output", join(tmp, "reports", "ive", "lifecycle_dispositions", "fixture_markdown_only_receipt.json"),
      "--write",
      "--json",
    ], tmp);
    const isolatedResult = isolatedWrite.parsed?.shipped_open?.find((entry) => entry.ticket_id === isolatedTicket.id);
    assert(!isolatedWrite.ok && isolatedResult?.blockers?.includes("scope_match"), "writer rejects undeclared-plan association found only in canonical Markdown");
    assert(readFileSync(isolatedPacketPath, "utf-8") === isolatedPacketBefore, "isolated blocked write preserves Program Packet bytes exactly");

    const outsideReceiptRel = "reports/ive/outside-root.json";
    const malformedReceiptRel = "reports/ive/push_receipts/malformed.json";
    const mismatchedReceiptRel = "reports/ive/push_receipts/mismatched.json";
    writeJson(join(tmp, outsideReceiptRel), matchedReceipt);
    writeFileSync(join(tmp, malformedReceiptRel), "{not-json\n", "utf-8");
    writeJson(join(tmp, mismatchedReceiptRel), { ...matchedReceipt, status: "FAIL" });

    const adversarialCases = [
      {
        id: "unexpired",
        expectedBlocker: "awaiting_evidence_expired",
        findingResolution: { status: "active", matched_path: matchedReceiptRel },
      },
      {
        id: "malformed-contract",
        expectedBlocker: "awaiting_contract_valid",
        awaiting: { ...validAwaitingExternalAction, kind: "unsupported" },
      },
      {
        id: "indeterminate",
        expectedBlocker: "awaiting_evidence_expired",
        findingResolution: { status: "indeterminate", warning: "scan_limit_reached" },
        chainPath: null,
      },
      {
        id: "unlinked",
        expectedBlocker: "awaiting_evidence_path_linked",
        chainPath: "reports/ive/push_receipts/unlinked.json",
      },
      {
        id: "outside-root",
        expectedBlocker: "awaiting_evidence_within_root",
        matchedPath: outsideReceiptRel,
      },
      {
        id: "missing",
        expectedBlocker: "awaiting_evidence_file",
        matchedPath: "reports/ive/push_receipts/missing.json",
      },
      {
        id: "malformed-json",
        expectedBlocker: "awaiting_evidence_json",
        matchedPath: malformedReceiptRel,
      },
      {
        id: "content-mismatch",
        expectedBlocker: "awaiting_evidence_matches_contract",
        matchedPath: mismatchedReceiptRel,
      },
      {
        id: "existing-resolution-archive",
        expectedBlocker: "awaiting_resolution_slot_available",
        existingResolution: {
          ...validAwaitingExternalAction,
          resolved_at: "2026-07-18T11:00:00.000Z",
          resolving_evidence: "reports/ive/push_receipts/older.json",
        },
      },
    ];

    for (const testCase of adversarialCases) {
      const scenarioPacketRel = `plans/programs/disp-negative/${testCase.id}/program_packet.json`;
      const scenarioPacketPath = join(tmp, scenarioPacketRel);
      const scenarioRepairPath = join(tmp, `reports/ive/lifecycle_reconciliation/${testCase.id}.json`);
      const scenarioReceiptPath = join(tmp, `reports/ive/lifecycle_dispositions/${testCase.id}.json`);
      const awaiting = testCase.awaiting || validAwaitingExternalAction;
      const scenarioTicket = ticket("T-DISP-VALID", "in_progress", {
        title: `External wait negative ${testCase.id}`,
        awaitingExternalAction: awaiting,
      });
      if (testCase.existingResolution) scenarioTicket.awaiting_external_action_resolved = testCase.existingResolution;
      const scenarioPacket = {
        version: 1,
        id: `PGM-DISP-NEG-${testCase.id.toUpperCase()}`,
        title: `Disposition negative ${testCase.id}`,
        status: "executing",
        goal: `Keep ${testCase.id} external-action evidence fail-closed.`,
        remote_mode: "local-only",
        story_refs: ["US-DISP"],
        epics: [{
          id: "EP-DISP",
          title: "Disposition",
          story_refs: ["US-DISP"],
          ticket_refs: ["T-DISP-VALID"],
        }],
        tickets: [scenarioTicket],
        acceptance_criteria: [criterion("T-DISP-VALID")],
        dependencies: [],
        compatibility_contracts: [],
        migration_boundaries: [],
        deletion_move_census: [],
        verification_matrix: [row("T-DISP-VALID")],
        decisions: [],
      };
      const matchedPath = testCase.matchedPath || matchedReceiptRel;
      const findingResolution = testCase.findingResolution || { status: "expired", matched_path: matchedPath };
      const chainPath = testCase.chainPath === null ? null : (testCase.chainPath || matchedPath);
      const evidenceChain = [
        ...(chainPath ? [{
          kind: "expected_external_evidence",
          status: "matched",
          path: chainPath,
          detail: "Adversarial external-action evidence candidate.",
        }] : []),
        {
          kind: "declared_child_plan",
          status: "closed",
          path: "plans/plan_valid",
          state_path: "plans/plan_valid/state.json",
          detail: "Declared child_plan.plan_dir is close.",
          closes_lifecycle: true,
        },
        {
          kind: "git_commit",
          status: "supporting",
          commit: commitHash.slice(0, 8),
          hash: commitHash,
          subject: "Disposition fixture evidence",
        },
      ];
      writeJson(scenarioPacketPath, scenarioPacket);
      writeJson(scenarioRepairPath, {
        findings: {
          shipped_open: [{
            id: "lifecycle:T-DISP-VALID",
            ticket_id: "T-DISP-VALID",
            ticket_title: scenarioTicket.title,
            program_id: scenarioPacket.id,
            packet_path: scenarioPacketRel,
            current_lifecycle: "in_progress",
            proposed_lifecycle: "closed",
            awaiting_external_action: findingResolution,
            evidence_chain: evidenceChain,
          }],
        },
      });

      const beforeAdversarial = readFileSync(scenarioPacketPath, "utf-8");
      const adversarialDryRun = run([
        "disposition",
        "--from-repair-packet", scenarioRepairPath,
        "--json",
      ], tmp);
      const dryEntry = adversarialDryRun.parsed?.shipped_open?.[0];
      assert(!adversarialDryRun.ok && dryEntry?.action === "keep_open", `${testCase.id} dry-run remains fail-closed`);
      assert(dryEntry?.blockers?.includes(testCase.expectedBlocker), `${testCase.id} dry-run names ${testCase.expectedBlocker}`);
      assert(readFileSync(scenarioPacketPath, "utf-8") === beforeAdversarial, `${testCase.id} dry-run preserves Program Packet bytes`);

      const adversarialWrite = run([
        "disposition",
        "--from-repair-packet", scenarioRepairPath,
        "--output", scenarioReceiptPath,
        "--write",
        "--json",
      ], tmp);
      const writeEntry = adversarialWrite.parsed?.shipped_open?.[0];
      assert(!adversarialWrite.ok && writeEntry?.action === "keep_open", `${testCase.id} write remains fail-closed`);
      assert(writeEntry?.blockers?.includes(testCase.expectedBlocker), `${testCase.id} write names ${testCase.expectedBlocker}`);
      assert(readFileSync(scenarioPacketPath, "utf-8") === beforeAdversarial, `${testCase.id} write preserves Program Packet bytes`);
    }

    const beforeRepeat = readFileSync(packetPath, "utf-8");
    const repeat = run([
      "disposition",
      "--from-repair-packet", repairPath,
      "--deferred-program", packetPath,
      "--output", join(tmp, "reports", "ive", "lifecycle_dispositions", "fixture_receipt_repeat.json"),
      "--write",
      "--json",
    ], tmp);
    assert(!repeat.ok && repeat.parsed?.shipped_open?.find((entry) => entry.ticket_id === "T-DISP-VALID")?.action === "already_closed", "repeat disposition treats closed ticket as idempotent");
    assert(readFileSync(packetPath, "utf-8") === beforeRepeat, "repeat disposition write leaves already applied packet state unchanged");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// T-INTAKE-2BD84327: proposed/no-child administrative resolution is authorized
// only by a clean committed request whose exact decision and every evidence ref
// can be recomputed from HEAD.
{
  function runGit(tmp, args) {
    return execFileSync("git", args, { cwd: tmp, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  }

  function writeJson(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  }

  function proposedTicket(id, { childPlan = null } = {}) {
    return {
      id,
      epic_id: "EP-RESOLUTION",
      title: `Resolution fixture ${id}`,
      type: "administrative",
      ticket_type: "administrative",
      lifecycle: "proposed",
      review_status: "not_run",
      story_refs: ["US-RESOLUTION"],
      defect_refs: [],
      gap_refs: [],
      depends_on: [],
      acceptance_criteria: [`AC-${id}`],
      child_plan: {
        policy: "required",
        plan_dir: childPlan,
        reason: "Resolution fixture policy.",
      },
      compatibility_contract_refs: [],
      migration_boundary_refs: [],
      deletion_move_census_refs: [],
      verification_refs: [`VM-${id}`],
      external_refs: [],
    };
  }

  function criterion(id) {
    return {
      id: `AC-${id}`,
      scope: "ticket",
      subject_ref: id,
      text: `Evidence-backed administrative resolution for ${id}.`,
      story_refs: ["US-RESOLUTION"],
      maintenance_rationale: null,
    };
  }

  function row(id) {
    return {
      id: `VM-${id}`,
      scope: "ticket",
      subject_ref: id,
      acceptance_criterion_ref: `AC-${id}`,
      proof_type: "proof:artifact_review",
      command_or_action: "Review the committed resolution request and evidence.",
      pass_means: "Every committed evidence reference passes.",
    };
  }

  const tmp = mkdtempSync(join(tmpdir(), "program-manager-proposed-resolution-"));
  try {
    runGit(tmp, ["init"]);
    const ticketIds = [
      "T-RESOLUTION-VALID",
      "T-RESOLUTION-NO-EVIDENCE",
      "T-RESOLUTION-BAD-RECEIPT",
      "T-RESOLUTION-MALFORMED-RECEIPT",
      "T-RESOLUTION-UNREACHABLE",
      "T-RESOLUTION-UNRELATED",
      "T-RESOLUTION-PREFIX",
      "T-RESOLUTION-UNSAFE",
      "T-RESOLUTION-CHILD",
    ];
    const packetRel = "plans/programs/resolution/program_packet.json";
    const packetPath = join(tmp, packetRel);
    const decisionsRel = "plans/plan_resolution/decisions.md";
    const passReceiptRel = "reports/ive/test_runs/pass/manifest.json";
    const failReceiptRel = "reports/ive/test_runs/fail/manifest.json";
    const malformedReceiptRel = "reports/ive/test_runs/malformed/manifest.json";
    const requestRel = "plans/plan_resolution/artifacts/proposed_resolution_request.json";
    const requestPath = join(tmp, requestRel);
    const duplicateRequestRel = "plans/plan_resolution/artifacts/duplicate_resolution_request.json";
    const outputPath = join(tmp, "reports/ive/lifecycle_dispositions/proposed_resolution_receipt.json");

    const packet = {
      version: 1,
      id: "PGM-RESOLUTION",
      title: "Proposed resolution fixture",
      status: "design",
      goal: "Exercise committed proposed-ticket administrative resolution.",
      remote_mode: "local-only",
      story_refs: ["US-RESOLUTION"],
      epics: [{
        id: "EP-RESOLUTION",
        title: "Resolution",
        story_refs: ["US-RESOLUTION"],
        ticket_refs: ticketIds,
      }],
      tickets: ticketIds.map((id) => proposedTicket(id, {
        childPlan: id === "T-RESOLUTION-CHILD" ? "plans/plan_child" : null,
      })),
      acceptance_criteria: ticketIds.map(criterion),
      dependencies: [],
      compatibility_contracts: [],
      migration_boundaries: [],
      deletion_move_census: [],
      verification_matrix: ticketIds.map(row),
      decisions: [],
    };
    writeJson(packetPath, packet);
    mkdirSync(dirname(join(tmp, decisionsRel)), { recursive: true });
    const decisionsText = [
      "# Decision Log",
      "",
      "## D-VALID — Resolve the exact valid ticket",
      "",
      "Committed evidence resolves T-RESOLUTION-VALID without a child plan.",
      "",
      "## D-NO-EVIDENCE — Evidence is still mandatory",
      "",
      "T-RESOLUTION-NO-EVIDENCE is named but has no evidence refs.",
      "",
      "## D-BAD-RECEIPT — Non-passing receipt",
      "",
      "T-RESOLUTION-BAD-RECEIPT is bound to a non-passing receipt.",
      "",
      "## D-MALFORMED-RECEIPT — Malformed receipt",
      "",
      "T-RESOLUTION-MALFORMED-RECEIPT is bound to malformed JSON.",
      "",
      "## D-UNREACHABLE — Unreachable commit",
      "",
      "T-RESOLUTION-UNREACHABLE must reject an object outside HEAD ancestry.",
      "",
      "## D-UNRELATED — Wrong subject",
      "",
      "This section deliberately names T-SOME-OTHER-TICKET.",
      "",
      "## D-PREFIX — Prefix collision",
      "",
      "This section names only T-RESOLUTION-PREFIX-EXTRA, not the shorter target.",
      "",
      "## D-CHILD — Child plan refusal",
      "",
      "T-RESOLUTION-CHILD retains a required child plan and cannot use this lane.",
      "",
    ].join("\n");
    writeFileSync(join(tmp, decisionsRel), decisionsText, "utf-8");
    writeJson(join(tmp, passReceiptRel), { schema_version: "ive.test_manifest.v1", status: "PASS", total: 1, passed: 1, warned: 0, failed: 0 });
    writeJson(join(tmp, failReceiptRel), { schema_version: "ive.test_manifest.v1", status: "FAIL", total: 1, passed: 0, warned: 0, failed: 1 });
    mkdirSync(dirname(join(tmp, malformedReceiptRel)), { recursive: true });
    writeFileSync(join(tmp, malformedReceiptRel), "{not-json\n", "utf-8");
    runGit(tmp, ["add", packetRel, decisionsRel, passReceiptRel, failReceiptRel, malformedReceiptRel]);
    runGit(tmp, ["-c", "user.name=Planner Test", "-c", "user.email=planner-test@example.com", "commit", "-m", "seed proposed resolution evidence"]);
    const reachableCommit = runGit(tmp, ["rev-parse", "HEAD"]);
    const unreachableCommit = runGit(tmp, ["commit-tree", `${reachableCommit}^{tree}`, "-m", "detached resolution evidence"]);

    const decision = (id) => ({ path: decisionsRel, id });
    const request = {
      schema_version: "program_proposed_resolution_request.v1",
      program_id: packet.id,
      program_packet_path: packetRel,
      resolutions: [
        {
          ticket_id: "T-RESOLUTION-VALID",
          classification: "resolved_by_evidence",
          decision_ref: decision("D-VALID"),
          evidence_refs: [
            { kind: "git_commit", commit: reachableCommit },
            { kind: "json_receipt", path: passReceiptRel },
          ],
        },
        {
          ticket_id: "T-RESOLUTION-NO-EVIDENCE",
          classification: "resolved_by_evidence",
          decision_ref: decision("D-NO-EVIDENCE"),
          evidence_refs: [],
        },
        {
          ticket_id: "T-RESOLUTION-BAD-RECEIPT",
          classification: "resolved_by_evidence",
          decision_ref: decision("D-BAD-RECEIPT"),
          evidence_refs: [{ kind: "json_receipt", path: failReceiptRel }],
        },
        {
          ticket_id: "T-RESOLUTION-MALFORMED-RECEIPT",
          classification: "resolved_by_evidence",
          decision_ref: decision("D-MALFORMED-RECEIPT"),
          evidence_refs: [{ kind: "json_receipt", path: malformedReceiptRel }],
        },
        {
          ticket_id: "T-RESOLUTION-UNREACHABLE",
          classification: "resolved_by_evidence",
          decision_ref: decision("D-UNREACHABLE"),
          evidence_refs: [{ kind: "git_commit", commit: unreachableCommit }],
        },
        {
          ticket_id: "T-RESOLUTION-UNRELATED",
          classification: "resolved_by_investigation",
          decision_ref: decision("D-UNRELATED"),
          evidence_refs: [{ kind: "git_commit", commit: reachableCommit }],
        },
        {
          ticket_id: "T-RESOLUTION-PREFIX",
          classification: "resolved_by_investigation",
          decision_ref: decision("D-PREFIX"),
          evidence_refs: [{ kind: "git_commit", commit: reachableCommit }],
        },
        {
          ticket_id: "T-RESOLUTION-UNSAFE",
          classification: "resolved_by_evidence",
          decision_ref: { path: "../outside-decisions.md", id: "D-UNSAFE" },
          evidence_refs: [{ kind: "git_commit", commit: reachableCommit }],
        },
        {
          ticket_id: "T-RESOLUTION-CHILD",
          classification: "resolved_by_evidence",
          decision_ref: decision("D-CHILD"),
          evidence_refs: [{ kind: "git_commit", commit: reachableCommit }],
        },
      ],
    };
    writeJson(requestPath, request);
    writeJson(join(tmp, duplicateRequestRel), {
      ...request,
      resolutions: [request.resolutions[0], request.resolutions[0]],
    });
    runGit(tmp, ["add", requestRel, duplicateRequestRel]);
    runGit(tmp, ["-c", "user.name=Planner Test", "-c", "user.email=planner-test@example.com", "commit", "-m", "commit proposed resolution request"]);

    const packetBefore = readFileSync(packetPath, "utf-8");
    const requestBefore = readFileSync(requestPath, "utf-8");
    const dryRun = run(["disposition", "--from-resolution-request", requestRel, "--json"], tmp);
    const validDry = dryRun.parsed?.proposed_resolutions?.find((entry) => entry.ticket_id === "T-RESOLUTION-VALID");
    assert(!dryRun.ok && dryRun.parsed?.status === "BLOCKED", "proposed resolution dry-run reports a mixed batch as BLOCKED");
    assert(validDry?.action === "would_admin_resolve" && validDry?.verification?.status === "PASS", "proposed resolution dry-run independently verifies the valid entry");
    assert(dryRun.parsed?.proposed_resolutions?.find((entry) => entry.ticket_id === "T-RESOLUTION-NO-EVIDENCE")?.blockers?.includes("resolution_evidence_required"), "proposed resolution rejects evidence-free closure");
    assert(dryRun.parsed?.proposed_resolutions?.find((entry) => entry.ticket_id === "T-RESOLUTION-BAD-RECEIPT")?.blockers?.includes("resolution_receipt_not_passing"), "proposed resolution rejects a non-passing receipt");
    assert(dryRun.parsed?.proposed_resolutions?.find((entry) => entry.ticket_id === "T-RESOLUTION-MALFORMED-RECEIPT")?.blockers?.includes("resolution_receipt_json_invalid"), "proposed resolution rejects malformed receipt JSON");
    assert(dryRun.parsed?.proposed_resolutions?.find((entry) => entry.ticket_id === "T-RESOLUTION-UNREACHABLE")?.blockers?.includes("resolution_commit_not_head_reachable"), "proposed resolution rejects an unreachable Git object");
    assert(dryRun.parsed?.proposed_resolutions?.find((entry) => entry.ticket_id === "T-RESOLUTION-UNRELATED")?.blockers?.includes("resolution_decision_ticket_mismatch"), "proposed resolution rejects an unrelated decision section");
    assert(dryRun.parsed?.proposed_resolutions?.find((entry) => entry.ticket_id === "T-RESOLUTION-PREFIX")?.blockers?.includes("resolution_decision_ticket_mismatch"), "proposed resolution uses boundary-safe ticket matching");
    assert(dryRun.parsed?.proposed_resolutions?.find((entry) => entry.ticket_id === "T-RESOLUTION-UNSAFE")?.blockers?.includes("resolution_decision_path_unsafe"), "proposed resolution rejects an escaping decision path");
    assert(dryRun.parsed?.proposed_resolutions?.find((entry) => entry.ticket_id === "T-RESOLUTION-CHILD")?.blockers?.includes("resolution_ticket_has_child_plan"), "proposed resolution refuses tickets with child plans");
    assert(readFileSync(packetPath, "utf-8") === packetBefore && readFileSync(requestPath, "utf-8") === requestBefore, "proposed resolution dry-run preserves Program and request bytes");

    const write = run([
      "disposition",
      "--from-resolution-request", requestRel,
      "--output", outputPath,
      "--write",
      "--json",
    ], tmp);
    const writtenPacket = JSON.parse(readFileSync(packetPath, "utf-8"));
    const resolvedTicket = writtenPacket.tickets.find((entry) => entry.id === "T-RESOLUTION-VALID");
    assert(!write.ok && write.parsed?.status === "BLOCKED" && write.parsed?.receipt_written === true, "proposed resolution write persists valid siblings and a BLOCKED mixed-batch receipt");
    assert(resolvedTicket.lifecycle === "closed" && resolvedTicket.review_status === "unavailable", "proposed resolution records administrative close without review-ready fabrication");
    assert(resolvedTicket.backlog_disposition?.classification === "resolved_by_evidence" && resolvedTicket.backlog_disposition?.resolution_evidence?.request_ref === requestRel, "proposed resolution persists normalized re-verifiable evidence");
    assert(writtenPacket.tickets.find((entry) => entry.id === "T-RESOLUTION-NO-EVIDENCE")?.lifecycle === "proposed", "mixed-batch invalid sibling remains proposed");
    assert(existsSync(outputPath), "proposed resolution write emits the requested receipt artifact");

    const check = run(["check", "--program", packetPath, "--json"], tmp);
    assert(check.ok && check.parsed?.status === "PASS", "Program check recomputes committed proposed-resolution evidence after write");
    const facts = run(["facts", "--program", packetPath], tmp);
    assert(facts.ok && facts.stdout.includes("ticket_administrative_closure('T-RESOLUTION-VALID')"), "Prolog facts recompute and classify the evidence-backed administrative closure");
    const copiedPacketPath = join(tmp, "plans/programs/resolution-copy/program_packet.json");
    writeJson(copiedPacketPath, writtenPacket);
    const copiedCheck = run(["check", "--program", copiedPacketPath, "--json"], tmp);
    assert(!copiedCheck.ok && copiedCheck.parsed?.errors?.some((entry) => entry.code === "ticket_verification_not_passed" && entry.path.includes("T-RESOLUTION-VALID")), "Program check rejects persisted resolution evidence copied to the wrong packet path");
    const copiedFacts = run(["facts", "--program", copiedPacketPath], tmp);
    assert(copiedFacts.ok && !copiedFacts.stdout.includes("ticket_administrative_closure('T-RESOLUTION-VALID')"), "Prolog facts reject proposed-resolution authority at the wrong packet path");
    const beforeRepeat = readFileSync(packetPath, "utf-8");
    const repeat = run([
      "disposition",
      "--from-resolution-request", requestRel,
      "--output", join(tmp, "reports/ive/lifecycle_dispositions/proposed_resolution_repeat.json"),
      "--write",
      "--json",
    ], tmp);
    assert(repeat.parsed?.proposed_resolutions?.find((entry) => entry.ticket_id === "T-RESOLUTION-VALID")?.action === "already_resolved", "proposed resolution write is idempotent for a re-verified closed ticket");
    assert(readFileSync(packetPath, "utf-8") === beforeRepeat, "idempotent proposed resolution leaves Program bytes unchanged");

    const duplicateRequest = run(["disposition", "--from-resolution-request", duplicateRequestRel, "--json"], tmp);
    assert(!duplicateRequest.ok && duplicateRequest.parsed?.error?.includes("resolution_request_duplicate_ticket"), "proposed resolution rejects duplicate exact ticket rows before mutation");
    writeFileSync(join(tmp, decisionsRel), `${decisionsText}\nmutable decision edit\n`, "utf-8");
    const dirtyDecision = run(["disposition", "--from-resolution-request", requestRel, "--json"], tmp);
    assert(dirtyDecision.parsed?.proposed_resolutions?.find((entry) => entry.ticket_id === "T-RESOLUTION-VALID")?.blockers?.includes("resolution_decision_not_clean"), "mutable-only decision bytes cannot authorize proposed resolution");
    writeFileSync(join(tmp, decisionsRel), decisionsText, "utf-8");
    writeJson(join(tmp, passReceiptRel), { schema_version: "ive.test_manifest.v1", status: "PASS", total: 2, passed: 2, warned: 0, failed: 0 });
    const dirtyReceipt = run(["disposition", "--from-resolution-request", requestRel, "--json"], tmp);
    assert(dirtyReceipt.parsed?.proposed_resolutions?.find((entry) => entry.ticket_id === "T-RESOLUTION-VALID")?.blockers?.includes("resolution_receipt_not_clean"), "mutable-only receipt bytes cannot authorize proposed resolution");

    writeFileSync(requestPath, `${requestBefore.trimEnd()}\n `, "utf-8");
    const dirtyRequest = run(["disposition", "--from-resolution-request", requestRel, "--json"], tmp);
    assert(!dirtyRequest.ok && dirtyRequest.parsed?.error?.includes("resolution_request_not_clean"), "mutable-only request bytes cannot authorize proposed resolution");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Forward-reasoning queries — Phase 1 of ritual elimination.
const dispatchChain = fixture("dispatch_chain.json");

result = run(["dispatch-order", "--program", dispatchChain, "--json"]);
const dispatchOrderIds = (result.parsed?.tickets || []).map((entry) => entry.id);
assert(result.ok && JSON.stringify(dispatchOrderIds) === JSON.stringify(["T-A", "T-B", "T-C", "T-D"]), "dispatch-order returns the full dependency-aware ticket order");

result = run(["next-ready", "--program", dispatchChain, "--json"]);
const nextReadyIds = (result.parsed?.tickets || []).map((entry) => entry.id).sort();
assert(result.ok && JSON.stringify(nextReadyIds) === JSON.stringify(["T-B", "T-D"]), "next-ready returns the unblocked ready tickets");

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-done-dep-"));
  try {
    const packetPath = join(tmp, "program_packet.json");
    const packet = JSON.parse(readFileSync(dispatchChain, "utf-8"));
    packet.tickets.find((ticket) => ticket.id === "T-A").lifecycle = "done";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");

    result = run(["next-ready", "--program", packetPath, "--json"], tmp);
    const doneDepReadyIds = (result.parsed?.tickets || []).map((entry) => entry.id).sort();
    assert(result.ok && JSON.stringify(doneDepReadyIds) === JSON.stringify(["T-D"]), "next-ready does not treat done dependency as verified proof");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

result = run(["blockers", "T-C", "--program", dispatchChain, "--json"]);
const blockerIds = (result.parsed?.tickets || []).map((entry) => entry.id);
assert(result.ok && blockerIds.includes("T-B"), "blockers returns transitive blocking ticket");

result = run(["unlocks-if-closed", "T-B", "--program", dispatchChain, "--json"]);
const unlockIds = (result.parsed?.tickets || []).map((entry) => entry.id);
assert(result.ok && unlockIds.includes("T-C"), "unlocks-if-closed returns the ticket newly unblocked by closing T-B");

result = run(["unlocks-if-closed", "T-A", "--program", dispatchChain, "--json"]);
assert(result.ok && (result.parsed?.tickets || []).length === 0, "unlocks-if-closed returns nothing when target is already verified");

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-dep-gate-"));
  try {
    const packetPath = join(tmp, "program_packet.json");
    const packet = JSON.parse(readFileSync(dispatchChain, "utf-8"));
    packet.status = "executing";
    for (const row of packet.verification_matrix) row.result = "pass";
    packet.tickets.find((ticket) => ticket.id === "T-B").type = "artifact";
    packet.tickets.find((ticket) => ticket.id === "T-C").lifecycle = "verified";
    packet.tickets.find((ticket) => ticket.id === "T-D").type = "artifact";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");

    result = run(["verify", "execution-to-program-validate", "--program", packetPath, "--json"], tmp);
    const depErrors = result.parsed?.errors || [];
    assert(!result.ok && hasError(result, "ticket_dependency_not_verified"), "program validation blocks verified ticket with an unverified dependency");
    assert(depErrors.some((entry) => /T-B/.test(entry.message || "")), "dependency gate names the missing prerequisite");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-stage3-dep-gate-"));
  try {
    const packetPath = join(tmp, "program_packet.json");
    const ticketIds = {
      e02: "T-INTAKE-2A496B0A",
      e01: "T-INTAKE-ACB6E1E9",
      e03: "T-INTAKE-CDA31E84",
    };
    const packet = {
      version: 1,
      id: "PGM-STAGE3-GATE",
      title: "Stage 3 dependency gate fixture",
      status: "executing",
      goal: "Prove measured quant tickets cannot validate before keystone dependencies.",
      story_refs: ["US-079"],
      epics: [{
        id: "EP-001",
        title: "Dependency gate",
        story_refs: ["US-079"],
        ticket_refs: [ticketIds.e02, ticketIds.e01, ticketIds.e03],
      }],
      tickets: [
        {
          id: ticketIds.e02,
          epic_id: "EP-001",
          title: "Two-layer gate split still open",
          type: "artifact",
          lifecycle: "ready",
          story_refs: ["US-079"],
          defect_refs: [],
          gap_refs: [],
          depends_on: [],
          acceptance_criteria: ["AC-E02"],
          child_plan: { policy: "not_required", plan_dir: null, reason: "fixture" },
          compatibility_contract_refs: [],
          migration_boundary_refs: [],
          deletion_move_census_refs: [],
          verification_refs: ["VM-E02"],
        },
        {
          id: ticketIds.e01,
          epic_id: "EP-001",
          title: "Bayesian ledger advanced too early",
          type: "artifact",
          lifecycle: "verified",
          story_refs: ["US-079"],
          defect_refs: [],
          gap_refs: [],
          depends_on: [ticketIds.e02],
          acceptance_criteria: ["AC-E01"],
          child_plan: { policy: "not_required", plan_dir: null, reason: "fixture" },
          compatibility_contract_refs: [],
          migration_boundary_refs: [],
          deletion_move_census_refs: [],
          verification_refs: ["VM-E01"],
        },
        {
          id: ticketIds.e03,
          epic_id: "EP-001",
          title: "Stage 3 measured quant ticket advanced too early",
          type: "artifact",
          lifecycle: "verified",
          story_refs: ["US-079"],
          defect_refs: [],
          gap_refs: [],
          depends_on: [ticketIds.e01],
          acceptance_criteria: ["AC-E03"],
          child_plan: { policy: "not_required", plan_dir: null, reason: "fixture" },
          compatibility_contract_refs: [],
          migration_boundary_refs: [],
          deletion_move_census_refs: [],
          verification_refs: ["VM-E03"],
        },
      ],
      acceptance_criteria: [
        { id: "AC-E02", scope: "ticket", subject_ref: ticketIds.e02, text: "e02 exists.", story_refs: ["US-079"], maintenance_rationale: null },
        { id: "AC-E01", scope: "ticket", subject_ref: ticketIds.e01, text: "e01 depends on e02.", story_refs: ["US-079"], maintenance_rationale: null },
        { id: "AC-E03", scope: "ticket", subject_ref: ticketIds.e03, text: "e03 depends on e01.", story_refs: ["US-079"], maintenance_rationale: null },
      ],
      dependencies: [],
      compatibility_contracts: [],
      migration_boundaries: [],
      deletion_move_census: [],
      verification_matrix: [
        { id: "VM-E02", scope: "ticket", subject_ref: ticketIds.e02, acceptance_criterion_ref: "AC-E02", proof_type: "proof:artifact_review", command_or_action: "review", pass_means: "ok", result: "pass" },
        { id: "VM-E01", scope: "ticket", subject_ref: ticketIds.e01, acceptance_criterion_ref: "AC-E01", proof_type: "proof:artifact_review", command_or_action: "review", pass_means: "ok", result: "pass" },
        { id: "VM-E03", scope: "ticket", subject_ref: ticketIds.e03, acceptance_criterion_ref: "AC-E03", proof_type: "proof:artifact_review", command_or_action: "review", pass_means: "ok", result: "pass" },
      ],
      decisions: [],
    };
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");

    result = run(["verify", "execution-to-program-validate", "--program", packetPath, "--json"], tmp);
    const depErrors = result.parsed?.errors || [];
    assert(!result.ok && hasError(result, "ticket_dependency_not_verified"), "Stage-3 dependency gate blocks measured ticket chain while e02 is open");
    assert(depErrors.some((entry) => /T-INTAKE-2A496B0A/.test(entry.message || "")), "Stage-3 dependency gate names e02 as the missing prerequisite");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

result = run(["next-ready", "--program", fixture("valid_ready.json"), "--json"]);
const validNext = (result.parsed?.tickets || []).map((entry) => entry.id);
assert(result.ok && validNext.includes("T-001"), "next-ready works on the original valid fixture");

result = run(["blockers", "T-MISSING", "--program", dispatchChain, "--json"]);
assert(result.ok && (result.parsed?.tickets || []).length === 0, "blockers on unknown ticket returns empty list, not error");

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-ticket-review-authority-"));
  try {
    const packetDir = join(tmp, "plans", "programs", "review-authority");
    const packetPath = join(packetDir, "program_packet.json");
    const registryPath = join(tmp, "reports", "user_story_audit", "story_registry.json");
    mkdirSync(packetDir, { recursive: true });
    mkdirSync(dirname(registryPath), { recursive: true });
    writeFileSync(registryPath, `${JSON.stringify({
      updated: "2026-07-14T00:00:00.000Z",
      stories: [],
      infrastructure_stories: [
        { id: "US-079", title: "Program Manager workflow and Program Packet validation", status: "FULLY_COVERED" },
        { id: "US-PM-AUTO-173", title: "Local and remote ticket sync contract", status: "FULLY_COVERED" },
      ],
      consolidations: [],
    }, null, 2)}\n`, "utf-8");

    const packet = {
      version: 1,
      id: "PGM-REVIEW-AUTHORITY",
      title: "Ticket review authority fixture",
      status: "executing",
      goal: "Keep ticket review authority separate from Program-wide readiness.",
      story_refs: ["US-079", "US-PM-AUTO-173"],
      epics: [{
        id: "EP-REVIEW",
        title: "Review tickets",
        story_refs: ["US-079", "US-PM-AUTO-173"],
        ticket_refs: ["T-HEALTHY", "T-UNRELATED"],
      }],
      tickets: [
        {
          id: "T-HEALTHY",
          epic_id: "EP-REVIEW",
          title: "Healthy reviewed ticket",
          type: "defect",
          lifecycle: "closed",
          review_status: "submitted",
          story_refs: ["US-079", "US-PM-AUTO-173"],
          defect_refs: [],
          gap_refs: [],
          depends_on: [],
          acceptance_criteria: ["AC-HEALTHY"],
          child_plan: { policy: "not_required", plan_dir: null, reason: "Self-contained review fixture" },
          compatibility_contract_refs: [],
          migration_boundary_refs: [],
          deletion_move_census_refs: [],
          verification_refs: ["VM-HEALTHY", "VM-HEALTHY-RECURRENCE"],
          external_refs: [{ kind: "github_issue", repo: "owner/repo", issue_number: 42, state: "OPEN", url: "https://github.com/owner/repo/issues/42" }],
          persona_packs: ["wiring_auditor", "config_integrity", "traceability", "assumptions_challenger"],
          persona_review: {
            status: "verified",
            persona_packs: ["wiring_auditor", "config_integrity", "traceability", "assumptions_challenger"],
            findings: [{ id: "PR-HEALTHY", status: "verified", evidence_refs: ["fixture:healthy"] }],
            evidence_refs: ["fixture:healthy"],
            authority: "advisory_only_deterministic_gates_remain_authoritative",
          },
        },
        {
          id: "T-UNRELATED",
          epic_id: "EP-REVIEW",
          title: "Unrelated broken ticket",
          type: "defect",
          lifecycle: "done",
          review_status: "submitted",
          story_refs: ["US-079"],
          defect_refs: [],
          gap_refs: [],
          depends_on: [],
          acceptance_criteria: ["AC-UNRELATED"],
          child_plan: { policy: "not_required", plan_dir: null, reason: "Self-contained review fixture" },
          compatibility_contract_refs: [],
          migration_boundary_refs: [],
          deletion_move_census_refs: [],
          verification_refs: ["VM-UNRELATED"],
        },
      ],
      acceptance_criteria: [
        { id: "AC-HEALTHY", scope: "ticket", subject_ref: "T-HEALTHY", text: "The healthy ticket review separates its verdict from unrelated Program failures.", story_refs: ["US-079", "US-PM-AUTO-173"], maintenance_rationale: null },
        { id: "AC-UNRELATED", scope: "ticket", subject_ref: "T-UNRELATED", text: "The unrelated ticket has its own deliberately failing verification control.", story_refs: ["US-079"], maintenance_rationale: null },
      ],
      dependencies: [],
      compatibility_contracts: [],
      migration_boundaries: [],
      deletion_move_census: [],
      verification_matrix: [
        { id: "VM-HEALTHY", scope: "ticket", subject_ref: "T-HEALTHY", acceptance_criterion_ref: "AC-HEALTHY", proof_type: "proof:integration_smoke", command_or_action: "Exercise ticket-local runReview acceptance and Program-context output.", pass_means: "The healthy target is review_ready while Program context remains blocked.", result: "pass", evidence_refs: ["fixture:healthy"] },
        { id: "VM-HEALTHY-RECURRENCE", scope: "ticket", subject_ref: "T-HEALTHY", acceptance_criterion_ref: "AC-HEALTHY", proof_type: "proof:migration_parity", command_or_action: "Run ripple_check migration-bootstrap transition-gate-flows planner_truth_packet test_knowledge_triggers rule_engine_check_invariants annotation_parser_validate and story_registry evidence.", pass_means: "Every active recurrence, routing, truth, migration, annotation, invariant, and story guard passes.", result: "pass", evidence_refs: ["ripple_check", "migration-bootstrap", "transition-gate-flows", "planner_truth_packet", "test_knowledge_triggers", "rule_engine_check_invariants", "annotation_parser_validate"] },
        { id: "VM-UNRELATED", scope: "ticket", subject_ref: "T-UNRELATED", acceptance_criterion_ref: "AC-UNRELATED", proof_type: "proof:seeded_failure_control", command_or_action: "Seed an unrelated ticket verification failure.", pass_means: "Whole-Program validation reports the unrelated failure.", result: "fail", evidence_refs: ["fixture:unrelated-failure"] },
      ],
      decisions: [],
    };
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");

    const ghRunner = () => ({
      status: 0,
      stdout: JSON.stringify({
        number: 42,
        title: "Healthy reviewed ticket",
        body: "Review the healthy ticket using its complete local contract and evidence.",
        state: "OPEN",
        url: "https://github.com/owner/repo/issues/42",
        labels: [],
        comments: [],
      }),
      stderr: "",
    });
    const commandRunner = (command) => ({
      status: 0,
      stdout: JSON.stringify({ status: "PASS", command: command.id }),
      stderr: "",
    });
    const reviewArgs = {
      command: "review",
      issue: "42",
      projectItem: null,
      program: packetPath,
      ticket: "T-HEALTHY",
      repo: "owner/repo",
      remoteMode: "remote-read",
      write: false,
      json: true,
      closeGithubIssue: false,
      acceptRemoteClose: false,
    };
    const reviewOptions = {
      cwd: tmp,
      ghRunner,
      commandRunner,
      clock: () => new Date("2026-07-14T00:00:00.000Z"),
    };

    const healthyReview = await runReview(reviewArgs, reviewOptions);
    const healthyPacket = healthyReview.review_packet;
    assert(healthyPacket?.final_status === "review_ready", "healthy ticket review is accepted while an unrelated Program ticket is broken");
    assert((healthyPacket?.deterministic?.blockers || []).length === 0, "healthy ticket has zero ticket-authoritative blockers");
    assert(healthyPacket?.deterministic?.program_context?.status === "blocked", "review artifact reports unrelated Program failure as separate blocked context");
    assert((healthyPacket?.deterministic?.program_context?.blockers || []).some((entry) => entry.path?.includes("VM-UNRELATED")), "Program context retains the unrelated verification failure");
    assert(healthyPacket?.deterministic?.program_packet_validation?.ok === false && Array.isArray(healthyPacket?.deterministic?.program_gates) && Array.isArray(healthyPacket?.deterministic?.command_results), "review artifact preserves detailed whole-Program validation, gates, and command results");
    assert(healthyPacket?.ticket_intake_receipt?.deterministic_blocker_count === 0 && healthyPacket?.ticket_intake_receipt?.program_context_status === "blocked", "Ticket Intake Receipt distinguishes ticket acceptance from blocked Program context");
    assert(/Program context: \*\*blocked\*\*/.test(healthyReview.github_sync?.planned_comment || ""), "GitHub dry-run comment keeps blocked Program context visible beside review_ready");
    assert(/Program context: blocked/.test(renderGithubReviewText(healthyReview)), "compact review output keeps separate Program context visible");

    packet.verification_matrix.find((entry) => entry.id === "VM-HEALTHY").result = "fail";
    packet.verification_matrix.find((entry) => entry.id === "VM-UNRELATED").result = "pass";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
    const brokenReview = await runReview(reviewArgs, reviewOptions);
    assert(brokenReview.review_packet?.final_status === "blocked", "broken reviewed ticket still fails its own review");
    assert((brokenReview.review_packet?.deterministic?.blockers || []).some((entry) => entry.path?.includes("VM-HEALTHY")), "broken review exposes the target-owned verification blocker");

    packet.verification_matrix.find((entry) => entry.id === "VM-HEALTHY").result = "pass";
    packet.tickets.find((entry) => entry.id === "T-HEALTHY").persona_review.status = "needs_evidence";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
    const personaBlockedReview = await runReview(reviewArgs, reviewOptions);
    assert((personaBlockedReview.review_packet?.deterministic?.blockers || []).some((entry) => entry.code === "ticket_closure_persona_review_needs_evidence"), "reviewed ticket persona evidence remains ticket-authoritative");

    packet.tickets.find((entry) => entry.id === "T-HEALTHY").persona_review.status = "verified";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
    const storyBlockedReview = await runReview(reviewArgs, {
      ...reviewOptions,
      commandRunner: (command) => command.id === "story_registry_evidence_us_079"
        ? { status: 7, stdout: "", stderr: "seeded target story evidence failure" }
        : commandRunner(command),
    });
    assert((storyBlockedReview.review_packet?.deterministic?.blockers || []).some((entry) => entry.source === "story_registry_evidence_us_079"), "reviewed ticket story evidence remains ticket-authoritative");

    packet.verification_matrix.find((entry) => entry.id === "VM-UNRELATED").result = "fail";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
    const programCheck = run(["check", "--program", packetPath, "--json"], tmp);
    assert(!programCheck.ok && hasError(programCheck, "ticket_verification_not_passed"), "whole-Program check remains blocked by the unrelated ticket");
    const programClose = run(["verify", "validate-to-program-close", "--program", packetPath, "--json"], tmp);
    assert(!programClose.ok && hasError(programClose, "ticket_verification_not_passed"), "program-close gate retains whole-Program failure authority");
    const publish = await runPublish({
      command: "publish",
      program: packetPath,
      ticket: "T-HEALTHY",
      repo: "owner/repo",
      project: null,
      remoteMode: "remote-sync",
      write: false,
      json: true,
    }, { cwd: tmp, clock: () => new Date("2026-07-14T00:00:00.000Z") });
    assert(publish.status === "BLOCKED" && publish.ticket_intake_receipt?.deterministic_blocker_count > 0, "publish dry-run remains blocked by whole-Program validation failure");
    assert(publish.publish_preflight?.blockers?.some((entry) => entry.code === "ready_ticket_missing_github_issue" && entry.path?.includes("T-UNRELATED")), "publish does not waive an unrelated ticket's missing GitHub mirror");
    const publishCli = runGithub([
      "publish", "--program", packetPath, "--ticket", "T-HEALTHY",
      "--repo", "owner/repo", "--remote-mode", "local-only", "--json",
    ], tmp);
    assert(Buffer.byteLength(publishCli.stdout || "", "utf-8") > 8192, "blocked publish CLI exercises a payload larger than the bounded pipe floor");
    assert(!publishCli.ok && publishCli.parsed?.status === "BLOCKED", "blocked publish CLI exits non-zero without remote action");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-canonical-id-"));
  try {
    const packetDir = join(tmp, "plans", "programs", "guidance-first");
    const packetPath = join(packetDir, "program_packet.json");
    mkdirSync(packetDir, { recursive: true });
    writeFileSync(packetPath, readFileSync(fixture("valid_ready.json"), "utf-8"));

    const byIdCheck = run(["check", "--program", "PGM-TEST", "--json"], tmp);
    const byPathCheck = run(["check", "--program", packetPath, "--json"], tmp);
    assert(byIdCheck.ok && byPathCheck.ok, "check accepts canonical Program ID and packet path");
    assert(byIdCheck.parsed?.packet_path === byPathCheck.parsed?.packet_path, "check ID and path forms select the same packet");

    const byIdVerify = run(["verify", "design-to-ready", "--program", "PGM-TEST", "--json"], tmp);
    assert(byIdVerify.ok && byIdVerify.parsed?.packet_path === byPathCheck.parsed?.packet_path, "verify accepts canonical Program ID");

    const byIdIntake = run([
      "intake", "--program", "PGM-TEST", "--title", "Canonical resolution probe",
      "--from-text", "US-001 defect. Prove canonical Program ID intake resolution.", "--json",
    ], tmp);
    assert(byIdIntake.ok && byIdIntake.parsed?.program_packet_path === "plans/programs/guidance-first/program_packet.json", "intake accepts canonical Program ID");

    const publish = runGithub(["publish", "--program", "PGM-TEST", "--ticket", "T-001", "--repo", "owner/repo", "--json"], tmp);
    assert(Buffer.byteLength(publish.stdout || "", "utf-8") > 8192, "publish CLI exercises a payload larger than the bounded pipe floor");
    assert(publish.ok && publish.parsed?.program_packet_path === "plans/programs/guidance-first/program_packet.json", "publish accepts canonical Program ID in dry-run mode");

    const binDir = join(tmp, "bin");
    const ghPath = join(binDir, "gh");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({number:42,title:"Canonical review",body:"Review canonical Program ID",state:"OPEN",url:"https://github.com/owner/repo/issues/42",labels:[],comments:[]}));
  process.exit(0);
}
console.error("Unexpected gh call: " + args.join(" "));
process.exit(1);
`);
    chmodSync(ghPath, 0o755);
    const review = runGithub([
      "review", "--issue", "42", "--program", "PGM-TEST", "--ticket", "T-001",
      "--repo", "owner/repo", "--remote-mode", "remote-read", "--json",
    ], tmp, { PATH: `${binDir}:${process.env.PATH || ""}` });
    assert(Buffer.byteLength(review.stdout || "", "utf-8") > 8192, "review CLI exercises a payload larger than the bounded pipe floor");
    assert(review.ok && review.parsed?.program_packet_path === "plans/programs/guidance-first/program_packet.json", "review accepts canonical Program ID with a stubbed remote read");

    const unknown = run(["check", "--program", "PGM-UNKNOWN", "--json"], tmp);
    assert(!unknown.ok && /Valid Program IDs: PGM-TEST/.test(errorMessages(unknown)), "unknown canonical ID fails and lists valid Program IDs");

    const duplicateDir = join(tmp, "plans", "programs", "duplicate");
    mkdirSync(duplicateDir, { recursive: true });
    writeFileSync(join(duplicateDir, "program_packet.json"), readFileSync(packetPath, "utf-8"));
    const ambiguous = run(["check", "--program", "PGM-TEST", "--json"], tmp);
    assert(!ambiguous.ok && /ambiguous/i.test(errorMessages(ambiguous)), "duplicate canonical ID fails as ambiguous");
    assert(/duplicate\/program_packet\.json/.test(errorMessages(ambiguous)) && /guidance-first\/program_packet\.json/.test(errorMessages(ambiguous)), "ambiguous canonical ID lists matching packet paths");
    assert(/Valid Program IDs: PGM-TEST/.test(errorMessages(ambiguous)), "ambiguous canonical ID lists valid Program IDs");

    const disambiguated = run(["check", "--program", packetPath, "--json"], tmp);
    assert(disambiguated.ok && disambiguated.parsed?.status === "PASS", "explicit packet path disambiguates duplicate canonical IDs");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\nCross-Program Prerequisites And Revival\n");

{
  const current = {
    id: "PGM-CURRENT",
    tickets: [{
      id: "T-CURRENT",
      lifecycle: "in_progress",
      external_prerequisites: [
        { program_ref: "PGM-TRUST", required_status: "closed" },
        { program_ref: "PGM-AUTONOMY", ticket_ref: "T-GRADER", required_lifecycle: "closed" },
      ],
    }],
  };
  const blocked = evaluateExternalPrerequisites(current, {
    programPackets: [
      { id: "PGM-TRUST", status: "closed", tickets: [] },
      { id: "PGM-AUTONOMY", status: "deferred", tickets: [{ id: "T-GRADER", lifecycle: "deferred" }] },
    ],
  });
  assert(!blocked.ok && blocked.blockers.some((entry) => entry.code === "ticket_external_prerequisite_lifecycle_mismatch" && entry.ticket_id === "T-CURRENT"), "structured cross-Program ticket prerequisite blocks on deferred lifecycle");

  const satisfied = evaluateExternalPrerequisites(current, {
    programPackets: [
      { id: "PGM-TRUST", status: "closed", tickets: [] },
      { id: "PGM-AUTONOMY", status: "executing", tickets: [{ id: "T-GRADER", lifecycle: "closed" }] },
    ],
  });
  assert(satisfied.ok && satisfied.prerequisites.every((entry) => entry.satisfied), "structured cross-Program prerequisites pass only against canonical Program/ticket state");
  const advanced = evaluateExternalPrerequisites({
    id: "PGM-ADVANCED",
    tickets: [{
      id: "T-ADVANCED",
      lifecycle: "in_progress",
      external_prerequisites: [{ program_ref: "PGM-AUTONOMY", ticket_ref: "T-GRADER", required_lifecycle: "in_progress" }],
    }],
  }, {
    programPackets: [{ id: "PGM-AUTONOMY", status: "closed", tickets: [{ id: "T-GRADER", lifecycle: "closed" }] }],
  });
  assert(advanced.ok && advanced.prerequisites[0]?.observed === "closed", "a forward-advanced ticket continues to satisfy an earlier minimum lifecycle prerequisite");
  const nonForward = evaluateExternalPrerequisites({
    id: "PGM-NON-FORWARD",
    tickets: [{
      id: "T-NON-FORWARD",
      lifecycle: "in_progress",
      external_prerequisites: [{ program_ref: "PGM-AUTONOMY", ticket_ref: "T-GRADER", required_lifecycle: "in_progress" }],
    }],
  }, {
    programPackets: [{ id: "PGM-AUTONOMY", status: "deferred", tickets: [{ id: "T-GRADER", lifecycle: "deferred" }] }],
  });
  assert(!nonForward.ok && nonForward.blockers[0]?.code === "ticket_external_prerequisite_lifecycle_mismatch", "blocked or deferred branches never satisfy a forward minimum lifecycle prerequisite");
  const malformed = evaluateExternalPrerequisites({
    id: "PGM-MALFORMED",
    tickets: [{
      id: "T-MALFORMED",
      lifecycle: "ready",
      external_prerequisites: [
        { program_ref: "PGM-TRUST", required_status: "impossible" },
        { program_ref: "PGM-AUTONOMY", ticket_ref: "T-GRADER", required_status: "closed", required_lifecycle: "closed" },
      ],
    }],
  }, {
    programPackets: [
      { id: "PGM-TRUST", status: "closed", tickets: [] },
      { id: "PGM-AUTONOMY", status: "closed", tickets: [{ id: "T-GRADER", lifecycle: "closed" }] },
    ],
  });
  assert(!malformed.ok && malformed.blockers.length === 2 && malformed.blockers.every((entry) => entry.code === "ticket_external_prerequisite_invalid"), "external prerequisite shape and enum drift fail closed instead of matching canonical authority accidentally");
  const facts = programPacketToFacts(current, {
    programPackets: [
      { id: "PGM-TRUST", status: "closed", tickets: [] },
      { id: "PGM-AUTONOMY", status: "deferred", tickets: [{ id: "T-GRADER", lifecycle: "deferred" }] },
    ],
  });
  assert(facts.includes("ticket_external_prerequisite('T-CURRENT', 'PGM-AUTONOMY', 'T-GRADER')") && facts.includes("ticket_external_prerequisite_unsatisfied('T-CURRENT', 'PGM-AUTONOMY', 'T-GRADER')"), "Program facts expose the same unsatisfied external prerequisite to Prolog");
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-deferral-"));
  try {
    const packetPath = join(tmp, "plans", "programs", "active-work", "program_packet.json");
    const childPlanRel = "plans/plan_2026-08-17_failed_active";
    const childPlanDir = join(tmp, childPlanRel);
    mkdirSync(dirname(packetPath), { recursive: true });
    mkdirSync(childPlanDir, { recursive: true });
    const fixturePacket = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
    fixturePacket.remote_mode = "local-only";
    fixturePacket.status = "executing";
    fixturePacket.tickets[0].lifecycle = "in_progress";
    fixturePacket.tickets[0].child_plan = {
      policy: "required",
      plan_dir: childPlanRel,
      reason: "Active work requires a governed child plan.",
    };
    writeFileSync(packetPath, `${JSON.stringify(fixturePacket, null, 2)}\n`);
    writeFileSync(join(childPlanDir, "state.json"), `${JSON.stringify({ state: "EXECUTE", transitions: [] }, null, 2)}\n`);
    const args = [
      "defer", "--program", packetPath, "--ticket", "T-001",
      "--decision", "D-DEFER-FAILED-ACTIVE", "--reason", "The bounded active attempt failed and its abandoned evidence is preserved.",
      "--child-plan", childPlanRel, "--json",
    ];

    const incomplete = run(["defer", "--program", packetPath, "--json"], tmp);
    assert(!incomplete.ok && /requires --program, --ticket, --decision, --reason, and --child-plan/.test(errorMessages(incomplete)), "defer rejects an incomplete exact-ticket contract");
    const nonterminalBefore = readFileSync(packetPath);
    const nonterminal = run(args, tmp);
    assert(!nonterminal.ok && /terminal CLOSE with \[ABANDONED\]/.test(errorMessages(nonterminal)), "defer rejects nonterminal child-plan evidence");
    assert(nonterminalBefore.equals(readFileSync(packetPath)), "blocked defer leaves Program Packet bytes unchanged");

    writeFileSync(join(childPlanDir, "state.json"), `${JSON.stringify({
      state: "CLOSE",
      transitions: [{ from: "EXECUTE", to: "CLOSE", marker: "[ABANDONED]" }],
    }, null, 2)}\n`);
    const collisionPacket = structuredClone(fixturePacket);
    collisionPacket.decisions.push({ id: "D-DEFER-FAILED-ACTIVE", type: "deferral", subject_ref: "T-OTHER", status: "accepted", rationale: "Collision fixture decision." });
    writeFileSync(packetPath, `${JSON.stringify(collisionPacket, null, 2)}\n`);
    const collision = run(args, tmp);
    assert(!collision.ok && /decision id collision/.test(errorMessages(collision)), "defer rejects a colliding decision id before mutation");

    writeFileSync(packetPath, `${JSON.stringify(fixturePacket, null, 2)}\n`);
    const before = readFileSync(packetPath);
    const dry = run(args, tmp);
    assert(dry.ok && dry.parsed?.action === "would_defer" && dry.parsed?.new_program_status === "deferred", "defer dry-run plans one exact active ticket and terminal Program status");
    assert(before.equals(readFileSync(packetPath)), "defer defaults to a non-writing dry-run");

    const written = run([...args.slice(0, -1), "--write", "--json"], tmp);
    const after = JSON.parse(readFileSync(packetPath, "utf-8"));
    const ticket = after.tickets.find((entry) => entry.id === "T-001");
    const decision = after.decisions.find((entry) => entry.id === "D-DEFER-FAILED-ACTIVE");
    assert(written.ok && written.parsed?.action === "deferred" && ticket?.lifecycle === "deferred" && after.status === "deferred", "defer write changes only the failed ticket lifecycle and aligns a fully terminal Program");
    assert(ticket?.deferral_decision_ref === "D-DEFER-FAILED-ACTIVE" && decision?.status === "accepted" && decision?.child_plan_terminal_state === "abandoned", "defer persists accepted decision and abandoned child-plan provenance");

    const afterWrite = readFileSync(packetPath);
    const repeat = run([...args.slice(0, -1), "--write", "--json"], tmp);
    assert(repeat.ok && repeat.parsed?.action === "already_deferred", "exact repeated defer is an idempotent success");
    assert(afterWrite.equals(readFileSync(packetPath)), "idempotent repeated defer leaves Program Packet byte-for-byte unchanged");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-revival-"));
  try {
    const packetPath = join(tmp, "plans", "programs", "self-improving", "program_packet.json");
    mkdirSync(dirname(packetPath), { recursive: true });
    const sourcePacket = join(repoRoot, "plans", "programs", "ive-self-improving-tests", "program_packet.json");
    const revivalFixture = JSON.parse(readFileSync(sourcePacket, "utf-8"));
    revivalFixture.status = "deferred";
    revivalFixture.decisions = revivalFixture.decisions.filter((entry) => entry.type !== "revival");
    for (const entry of revivalFixture.tickets) {
      if (!entry.revival_decision_ref) continue;
      entry.lifecycle = "deferred";
      delete entry.revival_decision_ref;
      if (entry.backlog_disposition) delete entry.backlog_disposition.revived_by_decision_ref;
      entry.child_plan = {
        policy: "required",
        plan_dir: null,
        reason: "Executable intake ticket requires a child iterative plan before implementation.",
      };
    }
    writeFileSync(packetPath, `${JSON.stringify(revivalFixture, null, 2)}\n`);
    const childPlanDir = join(tmp, "plans", "plan_2026-08-17_test");
    mkdirSync(childPlanDir, { recursive: true });
    writeFileSync(join(childPlanDir, "state.json"), `${JSON.stringify({ state: "EXECUTE" }, null, 2)}\n`);
    const before = readFileSync(packetPath, "utf-8");
    const missingContract = run(["revive", "--program", packetPath, "--json"], tmp);
    assert(!missingContract.ok && /requires --program, --ticket, --decision, --reason, and --child-plan/.test(errorMessages(missingContract)), "revive rejects an incomplete explicit-revival contract");
    const unsafePlan = run([
      "revive", "--program", packetPath, "--ticket", "T-INTAKE-EA5351FD",
      "--decision", "D-REVIVE-UNSAFE-PLAN", "--reason", "Reject absolute child-plan authority.",
      "--child-plan", childPlanDir, "--json",
    ], tmp);
    assert(!unsafePlan.ok && /repository-relative path/.test(errorMessages(unsafePlan)), "revive rejects absolute child-plan paths");
    const unknownTicket = run([
      "revive", "--program", packetPath, "--ticket", "T-NOT-PRESENT",
      "--decision", "D-REVIVE-UNKNOWN", "--reason", "Reject ambiguous or absent ticket authority.",
      "--child-plan", "plans/plan_2026-08-17_test", "--json",
    ], tmp);
    assert(!unknownTicket.ok && /resolve exactly once; found 0/.test(errorMessages(unknownTicket)), "revive rejects a ticket that is absent from the selected Program");
    const args = [
      "revive", "--program", packetPath, "--ticket", "T-INTAKE-EA5351FD",
      "--decision", "D-REVIVE-L2-TEST", "--reason", "Production grader contract is now implemented under governed O1 work.",
      "--child-plan", "plans/plan_2026-08-17_test", "--json",
    ];
    const dry = run(args, tmp);
    assert(dry.ok && dry.parsed?.status === "PASS" && dry.parsed?.action === "would_revive", "revive defaults to a non-writing dry-run with an exact accepted decision");
    assert(readFileSync(packetPath, "utf-8") === before, "revive dry-run leaves Program Packet bytes unchanged");

    const written = run([...args.slice(0, -1), "--write", "--json"], tmp);
    const after = JSON.parse(readFileSync(packetPath, "utf-8"));
    const ticket = after.tickets.find((entry) => entry.id === "T-INTAKE-EA5351FD");
    const decision = after.decisions.find((entry) => entry.id === "D-REVIVE-L2-TEST");
    assert(written.ok && written.parsed?.action === "revived" && ticket?.lifecycle === "in_progress" && after.status === "executing", "revive write advances only the selected deferred ticket and resumes a deferred Program");
    assert(ticket?.deferral_decision_ref && ticket?.revival_decision_ref === "D-REVIVE-L2-TEST" && decision?.previous_decision_ref === ticket.deferral_decision_ref && decision?.status === "accepted", "revive preserves deferral history and records the accepted revival decision");
    assert(ticket?.child_plan?.plan_dir === "plans/plan_2026-08-17_test", "revive links the explicit child plan without inventing one");

    const repeat = run([...args.slice(0, -1), "--write", "--json"], tmp);
    assert(!repeat.ok && /deferred/.test(errorMessages(repeat)), "revive rejects a non-deferred ticket and never revives implicitly");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioGithubMirrorDefaultPushOnly() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-gh-mirror-"));
  try {
    const packetDir = join(tmp, "plans", "programs", "test-mirror");
    mkdirSync(packetDir, { recursive: true });
    const packetPath = join(packetDir, "program_packet.json");
    const initRes = run(["init", "--program", "test-mirror", "--title", "Test Mirror", "--repo", "owner/test-repo", "--json"], tmp);
    assert(initRes.ok, "github mirror test: program initialized");

    // 1. Intake with GitHub unreachable (gh fails/offline) -> succeeds locally with queued record
    const offlineIntake = run([
      "intake", "--program", packetPath, "--from-text", "Offline feature request", "--write", "--json"
    ], tmp, { PATH: "/dev/null" }); // Ensure gh is not found / fails
    assert(offlineIntake.ok, "intake with GitHub unreachable succeeds locally");
    const offlinePacket = JSON.parse(readFileSync(packetPath, "utf-8"));
    const offlineTicket = offlinePacket.tickets[0];
    assert(offlineTicket && offlineTicket.github_sync?.status === "queued", "offline ticket records queued github_sync status");
    assert(offlineTicket.github_sync.pending_action === "publish", "offline ticket records pending publish action");

    // 2. Intake with mirror explicitly off -> no github_sync queued
    const noMirrorIntake = run([
      "intake", "--program", packetPath, "--from-text", "No mirror feature request", "--no-github-mirror", "--write", "--json"
    ], tmp);
    assert(noMirrorIntake.ok, "intake with --no-github-mirror succeeds");
    const noMirrorPacket = JSON.parse(readFileSync(packetPath, "utf-8"));
    const noMirrorTicket = noMirrorPacket.tickets.find((t) => t.title.includes("No mirror"));
    assert(noMirrorTicket && !noMirrorTicket.github_sync, "no-mirror ticket does not record github_sync");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioProgramManagerCliUsageAndHelp() {
  const helpResult = run(["--help"]);
  assert(helpResult.ok && helpResult.stdout.includes("program_manager.mjs — Program Packet validation"), "program_manager --help prints usage");

  const unknownCommand = run(["unknown-command"]);
  assert(!unknownCommand.ok && unknownCommand.stderr.includes("Unknown command: unknown-command"), "program_manager unknown command prints usage");

  const helpCommand = run(["help"]);
  assert(helpCommand.ok && helpCommand.stdout.includes("Program gates:"), "program_manager help prints program gates");
}

scenarioProgramManagerCliUsageAndHelp();
scenarioGithubMirrorDefaultPushOnly();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
