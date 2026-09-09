import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveGithubMirrorConfig,
  mirrorTicketPublish,
  mirrorTicketDefer,
  mirrorTicketClose,
  ensureRepoLabels,
  normalizeModeString,
} from "../scripts/lib/github_mirror.mjs";
import { runIntake, runDeferral } from "../scripts/program_manager.mjs";

test("Local-only and remote-read authority boundary guards", async (t) => {
  await t.test("resolveGithubMirrorConfig disables mirror in local-only and remote-read modes", () => {
    // Even when repo is explicitly provided or detected
    const localOnly = resolveGithubMirrorConfig({
      explicitRepo: "owner/repo",
      remoteMode: "local-only",
      explicitMirror: true,
    });
    assert.equal(localOnly.enabled, false, "local-only must disable mirror even if explicitMirror=true");

    const remoteRead = resolveGithubMirrorConfig({
      explicitRepo: "owner/repo",
      remoteMode: "remote-read",
      explicitMirror: true,
    });
    assert.equal(remoteRead.enabled, false, "remote-read must disable mirror even if explicitMirror=true");

    const envOverride = resolveGithubMirrorConfig({
      explicitRepo: "owner/repo",
      env: { PLANNER_REMOTE_MODE: "local-only" },
      explicitMirror: true,
    });
    assert.equal(envOverride.enabled, false, "env PLANNER_REMOTE_MODE=local-only must disable mirror");

    const packetMode = resolveGithubMirrorConfig({
      packet: { remote_policy: { mode: "local-only", repository_slug: "owner/repo" } },
      explicitMirror: true,
    });
    assert.equal(packetMode.enabled, false, "packet remote_policy.mode=local-only must disable mirror");

    const remoteSync = resolveGithubMirrorConfig({
      explicitRepo: "owner/repo",
      remoteMode: "remote-sync",
      explicitMirror: true,
    });
    assert.equal(remoteSync.enabled, true, "remote-sync must enable mirror when repo is provided");

    // Ambient detected git remote without configured repo or remote-sync mode must not auto-enable mirror
    const ambientDetected = resolveGithubMirrorConfig({
      projectRoot: process.cwd(),
    });
    assert.equal(ambientDetected.enabled, false, "ambient detected git remote without remote-sync must not enable mirror");
  });

  await t.test("mirrorTicketPublish strictly skips and makes 0 gh calls in local-only mode", () => {
    const ghCalls = [];
    const spyGhRunner = (args) => {
      ghCalls.push(args);
      return { ok: true, status: 0, stdout: "https://github.com/owner/repo/issues/123", stderr: "" };
    };

    const packet = { id: "PGM-TEST", title: "Test Program" };
    const ticket = { id: "T-001", title: "Test Ticket", lifecycle: "proposed" };

    const result = mirrorTicketPublish({
      packet,
      ticket,
      repo: "owner/repo",
      ghRunner: spyGhRunner,
      remoteMode: "local-only",
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "remote_mode_local-only");
    assert.equal(ghCalls.length, 0, "ghRunner must not be invoked in local-only mode");
  });

  await t.test("mirrorTicketPublish strictly skips and makes 0 gh calls in remote-read mode", () => {
    const ghCalls = [];
    const spyGhRunner = (args) => {
      ghCalls.push(args);
      return { ok: true, status: 0, stdout: "https://github.com/owner/repo/issues/123", stderr: "" };
    };

    const packet = { id: "PGM-TEST", title: "Test Program" };
    const ticket = { id: "T-001", title: "Test Ticket", lifecycle: "proposed" };

    const result = mirrorTicketPublish({
      packet,
      ticket,
      repo: "owner/repo",
      ghRunner: spyGhRunner,
      remoteMode: "remote-read",
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "remote_mode_remote-read");
    assert.equal(ghCalls.length, 0, "ghRunner must not be invoked in remote-read mode");
  });

  await t.test("mirrorTicketDefer and mirrorTicketClose strictly skip in local-only and remote-read modes", () => {
    const ghCalls = [];
    const spyGhRunner = (args) => {
      ghCalls.push(args);
      return { ok: true, status: 0, stdout: "", stderr: "" };
    };

    const packet = { id: "PGM-TEST" };
    const ticket = { id: "T-001", github_sync: { published_issue_number: 42 } };

    const deferLocal = mirrorTicketDefer({ packet, ticket, repo: "owner/repo", ghRunner: spyGhRunner, remoteMode: "local-only" });
    assert.equal(deferLocal.status, "skipped");

    const deferRead = mirrorTicketDefer({ packet, ticket, repo: "owner/repo", ghRunner: spyGhRunner, remoteMode: "remote-read" });
    assert.equal(deferRead.status, "skipped");

    const closeLocal = mirrorTicketClose({ packet, ticket, repo: "owner/repo", ghRunner: spyGhRunner, remoteMode: "local-only" });
    assert.equal(closeLocal.status, "skipped");

    const closeRead = mirrorTicketClose({ packet, ticket, repo: "owner/repo", ghRunner: spyGhRunner, remoteMode: "remote-read" });
    assert.equal(closeRead.status, "skipped");

    assert.equal(ghCalls.length, 0, "Zero gh calls must be made across defer/close in non-sync modes");
  });

  await t.test("cmdIntake with write: true makes 0 gh calls in local-only and remote-read modes", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "program-mgr-test-"));
    try {
      const pgmDir = join(tempDir, "plans", "programs", "test-program");
      mkdirSync(pgmDir, { recursive: true });
      const packetPath = join(pgmDir, "program_packet.json");
      const initialPacket = {
        schema_version: 1,
        id: "PGM-TEST",
        title: "Test Program",
        goal: "Test program intake authority boundary",
        status: "design",
        remote_policy: {
          mode: "local-only",
          repository_slug: "mock/remote-repo",
        },
        epics: [{ id: "EP-001", title: "Test Epic", description: "Epic description" }],
        tickets: [],
        dependencies: [],
        decisions: [],
      };
      writeFileSync(packetPath, JSON.stringify(initialPacket, null, 2), "utf-8");

      const ghCalls = [];
      const spyGhRunner = (args) => {
        ghCalls.push(args);
        return { ok: true, status: 0, stdout: "https://github.com/mock/remote-repo/issues/999", stderr: "" };
      };

      // Test runIntake in local-only mode
      await runIntake(
        {
          command: "intake",
          program: "test-program",
          fromText: "New test idea for local-only intake",
          title: "Intake Ticket 1",
          write: true,
          remoteMode: "local-only",
          repo: "mock/remote-repo",
        },
        {
          cwd: tempDir,
          ghRunner: spyGhRunner,
          env: {},
        }
      );

      assert.equal(ghCalls.length, 0, "runIntake must make 0 gh calls in local-only mode");

      // Test runIntake in remote-read mode
      await runIntake(
        {
          command: "intake",
          program: "test-program",
          fromText: "New test idea for remote-read intake",
          title: "Intake Ticket 2",
          write: true,
          remoteMode: "remote-read",
          repo: "mock/remote-repo",
        },
        {
          cwd: tempDir,
          ghRunner: spyGhRunner,
          env: {},
        }
      );

      assert.equal(ghCalls.length, 0, "runIntake must make 0 gh calls in remote-read mode");

      // Test runIntake inheriting packet.remote_mode="local-only" without CLI flag
      const packetPathLocalOnly = join(pgmDir, "program_packet_local.json");
      const packetLocalOnly = {
        schema_version: 1,
        id: "PGM-LOCAL",
        title: "Local Only Program",
        goal: "Test packet remote_mode inheritance",
        status: "design",
        remote_mode: "local-only",
        repo: "mock/remote-repo",
        epics: [{ id: "EP-001", title: "Test Epic", description: "Epic description" }],
        tickets: [],
        dependencies: [],
        decisions: [],
      };
      writeFileSync(packetPathLocalOnly, JSON.stringify(packetLocalOnly, null, 2), "utf-8");

      await runIntake(
        {
          command: "intake",
          program: packetPathLocalOnly,
          fromText: "New ticket inheriting packet remote_mode local-only",
          title: "Inherited Local Ticket",
          write: true,
          repo: "mock/remote-repo",
        },
        {
          cwd: tempDir,
          ghRunner: spyGhRunner,
          env: {},
        }
      );

      assert.equal(ghCalls.length, 0, "runIntake without CLI flag must inherit packet remote_mode=local-only and make 0 gh calls");

      // Test runIntake with --issue (implicit remote-read) without CLI remoteMode flag
      const packetPathRemoteRead = join(pgmDir, "program_packet_read.json");
      const packetRemoteRead = {
        schema_version: 1,
        id: "PGM-READ",
        title: "Remote Read Program",
        goal: "Test implicit remote-read from issue intake",
        status: "design",
        repo: "mock/remote-repo",
        epics: [{ id: "EP-001", title: "Test Epic", description: "Epic description" }],
        tickets: [],
        dependencies: [],
        decisions: [],
      };
      writeFileSync(packetPathRemoteRead, JSON.stringify(packetRemoteRead, null, 2), "utf-8");

      const spyGhRunnerWithRead = (args) => {
        ghCalls.push(args);
        if (args[0] === "issue" && args[1] === "view") {
          return {
            ok: true,
            status: 0,
            stdout: JSON.stringify({
              number: 123,
              title: "Imported Issue Title",
              body: "Imported Issue Body",
              state: "OPEN",
              labels: [],
            }),
            stderr: "",
          };
        }
        return { ok: true, status: 0, stdout: "", stderr: "" };
      };

      const callsBefore = ghCalls.length;
      await runIntake(
        {
          command: "intake",
          program: packetPathRemoteRead,
          issue: 123,
          write: true,
          repo: "mock/remote-repo",
        },
        {
          cwd: tempDir,
          ghRunner: spyGhRunnerWithRead,
          env: {},
        }
      );

      const writeCalls = ghCalls.slice(callsBefore).filter((c) => c[0] === "issue" && c[1] === "create" || c[0] === "label");
      assert.equal(writeCalls.length, 0, "runIntake with --issue (implicit remote-read) must never make gh issue create or label create calls");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test("packet.remote_mode top-level field is respected across mirror functions", () => {
    const configLocal = resolveGithubMirrorConfig({
      packet: { remote_mode: "local-only", repo: "owner/repo" },
      explicitRepo: "owner/repo",
    });
    assert.equal(configLocal.enabled, false, "packet.remote_mode=local-only must disable mirror");

    const configRead = resolveGithubMirrorConfig({
      packet: { remote_mode: "remote-read", repo: "owner/repo" },
      explicitRepo: "owner/repo",
    });
    assert.equal(configRead.enabled, false, "packet.remote_mode=remote-read must disable mirror");

    const ghCalls = [];
    const spy = (args) => {
      ghCalls.push(args);
      return { ok: true, status: 0, stdout: "", stderr: "" };
    };

    const pubLocal = mirrorTicketPublish({
      packet: { id: "PGM-P", remote_mode: "local-only" },
      ticket: { id: "T-1", title: "T" },
      repo: "owner/repo",
      ghRunner: spy,
    });
    assert.equal(pubLocal.status, "skipped");
    assert.equal(pubLocal.reason, "remote_mode_local-only");

    const deferLocal = mirrorTicketDefer({
      packet: { id: "PGM-P", remote_mode: "local-only" },
      ticket: { id: "T-1", github_sync: { published_issue_number: 10 } },
      repo: "owner/repo",
      ghRunner: spy,
    });
    assert.equal(deferLocal.status, "skipped");

    const closeLocal = mirrorTicketClose({
      packet: { id: "PGM-P", remote_mode: "local-only" },
      ticket: { id: "T-1", github_sync: { published_issue_number: 10 } },
      repo: "owner/repo",
      ghRunner: spy,
    });
    assert.equal(closeLocal.status, "skipped");

    assert.equal(ghCalls.length, 0, "No gh calls when inheriting packet.remote_mode=local-only");
  });

  await t.test("Reproduction config with repository_slug and remote_mode=local-only in runIntake makes 0 gh calls", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "program-mgr-repro-"));
    try {
      const pgmDir = join(tempDir, "plans", "programs", "review-fixture");
      mkdirSync(pgmDir, { recursive: true });
      const packetPath = join(pgmDir, "program_packet.json");
      const reproPacket = {
        schema_version: 1,
        id: "PGM-REPRO",
        title: "Repro Program",
        goal: "Verify remote_mode is not bypassed by repository_slug",
        status: "design",
        remote_mode: "local-only",
        remote_policy: { repository_slug: "example/review-fixture" },
        epics: [{ id: "EP-001", title: "Test Epic", description: "Epic description" }],
        tickets: [],
        dependencies: [],
        decisions: [],
      };
      writeFileSync(packetPath, JSON.stringify(reproPacket, null, 2), "utf-8");

      const ghCalls = [];
      const spyGhRunner = (args) => {
        ghCalls.push(args);
        return { ok: true, status: 0, stdout: "https://github.com/example/review-fixture/issues/1", stderr: "" };
      };

      const result = await runIntake(
        {
          command: "intake",
          program: packetPath,
          fromText: "New test ticket with reproduction config",
          title: "Repro Ticket",
          write: true,
        },
        {
          cwd: tempDir,
          ghRunner: spyGhRunner,
          env: {},
        }
      );

      assert.equal(result.remote_mode, "local-only", "runIntake must report remote_mode=local-only");
      assert.equal(ghCalls.length, 0, "runIntake with reproduction config must make 0 gh calls (no labels, no issues)");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test("All mirror helpers with reproduction config strictly skip and make 0 gh calls", () => {
    const ghCalls = [];
    const spy = (args) => {
      ghCalls.push(args);
      return { ok: true, status: 0, stdout: "", stderr: "" };
    };

    const reproPacket = {
      id: "PGM-REPRO",
      remote_mode: "local-only",
      remote_policy: { repository_slug: "example/review-fixture" },
    };
    const ticket = { id: "T-REPRO", title: "Repro Ticket", github_sync: { published_issue_number: 42 } };

    const pubResult = mirrorTicketPublish({ packet: reproPacket, ticket, ghRunner: spy });
    assert.equal(pubResult.status, "skipped");
    assert.equal(pubResult.reason, "remote_mode_local-only");

    const closeResult = mirrorTicketClose({ packet: reproPacket, ticket, ghRunner: spy });
    assert.equal(closeResult.status, "skipped");

    const deferResult = mirrorTicketDefer({ packet: reproPacket, ticket, ghRunner: spy });
    assert.equal(deferResult.status, "skipped");

    assert.equal(ghCalls.length, 0, "Zero gh calls across publish/close/defer with reproduction config");
  });

  await t.test("Conflicting packet remote policies fail closed with 0 gh calls", () => {
    const ghCalls = [];
    const spy = (args) => {
      ghCalls.push(args);
      return { ok: true, status: 0, stdout: "", stderr: "" };
    };

    const conflictPacket = {
      id: "PGM-CONFLICT",
      remote_mode: "local-only",
      remote_policy: { mode: "remote-sync", repository_slug: "example/conflict-fixture" },
    };
    const ticket = { id: "T-CONF", title: "Conflict Ticket" };

    const resolved = resolveGithubMirrorConfig({ packet: conflictPacket });
    assert.equal(resolved.enabled, false, "Conflicting policy must fail closed (enabled=false)");
    assert.equal(resolved.conflict, true, "Conflicting policy must flag conflict=true");

    const pubResult = mirrorTicketPublish({ packet: conflictPacket, ticket, ghRunner: spy });
    assert.equal(pubResult.status, "skipped");
    assert.equal(pubResult.conflict, true);
    assert.equal(ghCalls.length, 0, "Zero gh calls when packet policy conflicts");
  });

  await t.test("Positive remote-sync mode enables mirror and creates issue via ghRunner", () => {
    const ghCalls = [];
    const spy = (args) => {
      ghCalls.push(args);
      return { ok: true, status: 0, stdout: "https://github.com/example/sync-repo/issues/42", stderr: "" };
    };

    const syncPacket = {
      id: "PGM-SYNC",
      remote_policy: { mode: "remote-sync", repository_slug: "example/sync-repo" },
    };
    const ticket = { id: "T-SYNC", title: "Sync Ticket", lifecycle: "proposed" };

    const resolved = resolveGithubMirrorConfig({ packet: syncPacket });
    assert.equal(resolved.enabled, true, "Explicit remote-sync with repo must enable mirror");
    assert.equal(resolved.repo, "example/sync-repo");

    const pubResult = mirrorTicketPublish({ packet: syncPacket, ticket, ghRunner: spy });
    assert.equal(pubResult.status, "published");
    assert.equal(pubResult.issue_number, 42);
    assert(ghCalls.length > 0, "ghRunner was invoked for positive remote-sync publish");
    assert(ghCalls.some((c) => c[0] === "issue" && c[1] === "create"));
  });

  await t.test("ensureRepoLabels enforces authority and makes zero gh calls without explicit remote-sync", () => {
    const ghCalls = [];
    const spy = (args) => {
      ghCalls.push(args);
      return { ok: true, status: 0, stdout: "", stderr: "" };
    };

    // 1. Calling ensureRepoLabels with repo but no remoteMode must fail closed (zero calls)
    ensureRepoLabels({ repo: "owner/repo", labels: ["label1", "label2"], ghRunner: spy });
    assert.equal(ghCalls.length, 0, "ensureRepoLabels with repo alone must make 0 gh calls");

    // 2. Calling with reproduction config
    ensureRepoLabels({
      repo: "example/review-fixture",
      labels: ["label1"],
      ghRunner: spy,
      packet: { remote_mode: "local-only", remote_policy: { repository_slug: "example/review-fixture" } },
    });
    assert.equal(ghCalls.length, 0, "ensureRepoLabels with reproduction config must make 0 gh calls");

    // 3. Calling with remoteMode='remote-read'
    ensureRepoLabels({ repo: "owner/repo", labels: ["label1"], ghRunner: spy, remoteMode: "remote-read" });
    assert.equal(ghCalls.length, 0, "ensureRepoLabels in remote-read must make 0 gh calls");

    // 4. Calling with remoteMode='remote-sync' and explicit repo succeeds
    ensureRepoLabels({
      repo: "owner/repo",
      labels: ["label1", "label2"],
      ghRunner: spy,
      remoteMode: "remote-sync",
      explicitMirror: true,
    });
    assert.equal(ghCalls.length, 2, "ensureRepoLabels in remote-sync mode must create labels");
    assert.equal(ghCalls[0][0], "label");
    assert.equal(ghCalls[0][1], "create");
  });

  await t.test("normalizeModeString handles all supported aliases and casings", () => {
    assert.equal(normalizeModeString("local"), "local-only");
    assert.equal(normalizeModeString("local-only"), "local-only");
    assert.equal(normalizeModeString("LOCAL_ONLY"), "local-only");
    assert.equal(normalizeModeString("local_only"), "local-only");
    assert.equal(normalizeModeString("read"), "remote-read");
    assert.equal(normalizeModeString("remote-read"), "remote-read");
    assert.equal(normalizeModeString("REMOTE_READ"), "remote-read");
    assert.equal(normalizeModeString("remote_read"), "remote-read");
    assert.equal(normalizeModeString("sync"), "remote-sync");
    assert.equal(normalizeModeString("remote-sync"), "remote-sync");
    assert.equal(normalizeModeString("REMOTE_SYNC"), "remote-sync");
    assert.equal(normalizeModeString("remote_sync"), "remote-sync");
    assert.equal(normalizeModeString(null), null);
    assert.equal(normalizeModeString(undefined), null);
    assert.equal(normalizeModeString(""), null);
  });

  await t.test("resolveGithubMirrorConfig handles environment defaults and conflict validation", () => {
    // PLANNER_REMOTE_MODE=local environment override
    const envLocal = resolveGithubMirrorConfig({
      explicitRepo: "owner/repo",
      env: { PLANNER_REMOTE_MODE: "local" },
    });
    assert.equal(envLocal.enabled, false);
    assert.equal(envLocal.remoteMode, "local-only");

    // PLANNER_REMOTE_MODE=read environment override
    const envRead = resolveGithubMirrorConfig({
      explicitRepo: "owner/repo",
      env: { PLANNER_REMOTE_MODE: "read" },
    });
    assert.equal(envRead.enabled, false);
    assert.equal(envRead.remoteMode, "remote-read");

    // PLANNER_GITHUB_MIRROR=0 or false environment override
    const envMirrorOff = resolveGithubMirrorConfig({
      explicitRepo: "owner/repo",
      remoteMode: "remote-sync",
      env: { PLANNER_GITHUB_MIRROR: "0" },
    });
    assert.equal(envMirrorOff.enabled, false);

    // Conflict between explicitMirror=true and local-only
    const conflictMirror = resolveGithubMirrorConfig({
      explicitRepo: "owner/repo",
      remoteMode: "local-only",
      explicitMirror: true,
    });
    assert.equal(conflictMirror.enabled, false);
    assert.equal(conflictMirror.conflict, true);

    // Conflict between packet remote_mode='local-only' and remote_policy.mode='remote-sync'
    const conflictPacketModes = resolveGithubMirrorConfig({
      packet: {
        remote_mode: "local-only",
        remote_policy: { mode: "remote-sync", repository_slug: "owner/repo" },
      },
    });
    assert.equal(conflictPacketModes.enabled, false);
    assert.equal(conflictPacketModes.conflict, true);
  });

  await t.test("Malformed/unknown remote modes fail closed with 0 gh calls across all mirror helpers", () => {
    const ghCalls = [];
    const spyGhRunner = (args) => {
      ghCalls.push(args);
      return { ok: true, status: 0, stdout: "123", stderr: "" };
    };

    const malformedConfigs = [
      { mode: "remote-snyc", label: "typo remote-snyc" },
      { mode: "invalid_mode", label: "arbitrary string" },
      { mode: "local-sync", label: "hybrid non-canonical" },
      { mode: "none", label: "none" },
    ];

    for (const { mode, label } of malformedConfigs) {
      const packet = {
        id: "PGM-MALFORMED",
        remote_mode: mode,
        remote_policy: { repository_slug: "example/review-fixture" },
      };
      const ticket = { id: "T-MAL-1", title: "Malformed Test" };

      // Config check
      const config = resolveGithubMirrorConfig({ packet, env: { PLANNER_GITHUB_MIRROR: "1" } });
      assert.equal(config.enabled, false, `[${label}] config.enabled must be false`);
      assert.equal(config.conflict, true, `[${label}] config.conflict must be true`);
      assert.equal(config.reason, "invalid_remote_mode", `[${label}] reason must be invalid_remote_mode`);

      // mirrorTicketPublish check
      const callsBefore = ghCalls.length;
      const pub = mirrorTicketPublish({ packet, ticket, env: { PLANNER_GITHUB_MIRROR: "1" }, ghRunner: spyGhRunner });
      assert.equal(pub.status, "skipped", `[${label}] publish must skip`);
      assert.equal(ghCalls.length, callsBefore, `[${label}] publish must make 0 gh calls`);

      // ensureRepoLabels check
      ensureRepoLabels({ packet, labels: ["test-label"], env: { PLANNER_GITHUB_MIRROR: "1" }, ghRunner: spyGhRunner });
      assert.equal(ghCalls.length, callsBefore, `[${label}] ensureRepoLabels must make 0 gh calls`);

      // mirrorTicketDefer check
      const defer = mirrorTicketDefer({ packet, ticket: { id: "T-01", github_sync: { published_issue_number: 1 } }, env: { PLANNER_GITHUB_MIRROR: "1" }, ghRunner: spyGhRunner });
      assert.equal(defer.status, "skipped", `[${label}] defer must skip`);
      assert.equal(ghCalls.length, callsBefore, `[${label}] defer must make 0 gh calls`);

      // mirrorTicketClose check
      const close = mirrorTicketClose({ packet, ticket: { id: "T-01", github_sync: { published_issue_number: 1 } }, env: { PLANNER_GITHUB_MIRROR: "1" }, ghRunner: spyGhRunner });
      assert.equal(close.status, "skipped", `[${label}] close must skip`);
      assert.equal(ghCalls.length, callsBefore, `[${label}] close must make 0 gh calls`);
    }
  });

  await t.test("runIntake preserves explicit mirror options and forwards validated authority", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), ".test_intake_forward_"));
    const pgmDir = join(tempDir, "programs", "test-forward");
    mkdirSync(pgmDir, { recursive: true });

    try {
      const ghCalls = [];
      const spyGhRunner = (args) => {
        ghCalls.push(args);
        return { ok: true, status: 0, stdout: "https://github.com/example/fixture/issues/999", stderr: "" };
      };

      // 1. Authorized explicit enablement: remote-sync packet with policy.github_mirror: false + CLI --github-mirror
      const packetSyncPath = join(pgmDir, "packet_sync.json");
      const packetSync = {
        schema_version: 1,
        id: "PGM-SYNC-FORWARD",
        title: "Sync Forward Program",
        goal: "Test explicit mirror forwarding",
        status: "design",
        remote_mode: "remote-sync",
        policy: { github_mirror: false },
        remote_policy: { repository_slug: "example/fixture" },
        epics: [{ id: "EP-01", title: "Epic", description: "Desc" }],
        tickets: [],
        dependencies: [],
        decisions: [],
      };
      writeFileSync(packetSyncPath, JSON.stringify(packetSync, null, 2), "utf-8");

      const callsBefore1 = ghCalls.length;
      const res1 = await runIntake(
        {
          command: "intake",
          program: packetSyncPath,
          fromText: "New ticket with explicit mirror",
          title: "Explicit Enabled Ticket",
          write: true,
          githubMirror: true,
        },
        { cwd: tempDir, ghRunner: spyGhRunner, env: {} }
      );

      const callsAfter1 = ghCalls.length - callsBefore1;
      assert.ok(callsAfter1 > 0, "runIntake with --github-mirror on remote-sync packet must invoke gh commands");
      assert.equal(res1.candidate_ticket?.github_sync?.status, "synced", "candidate ticket must record synced status");
      assert.ok(res1.candidate_ticket?.github_sync?.published_issue_number, "candidate ticket must have issue number");

      // 2. Explicit disablement: remote-sync packet with policy.github_mirror: true + CLI --no-github-mirror
      const packetSyncOnPath = join(pgmDir, "packet_sync_on.json");
      const packetSyncOn = {
        schema_version: 1,
        id: "PGM-SYNC-DISABLE",
        title: "Sync Disable Program",
        goal: "Test explicit mirror disablement",
        status: "design",
        remote_mode: "remote-sync",
        policy: { github_mirror: true },
        remote_policy: { repository_slug: "example/fixture" },
        epics: [{ id: "EP-01", title: "Epic", description: "Desc" }],
        tickets: [],
        dependencies: [],
        decisions: [],
      };
      writeFileSync(packetSyncOnPath, JSON.stringify(packetSyncOn, null, 2), "utf-8");

      const callsBefore2 = ghCalls.length;
      const res2 = await runIntake(
        {
          command: "intake",
          program: packetSyncOnPath,
          fromText: "New ticket with explicit mirror off",
          title: "Explicit Disabled Ticket",
          write: true,
          githubMirror: false,
        },
        { cwd: tempDir, ghRunner: spyGhRunner, env: {} }
      );

      assert.equal(ghCalls.length - callsBefore2, 0, "runIntake with --no-github-mirror must make zero gh calls");
      assert.equal(res2.candidate_ticket?.github_sync, undefined, "ticket must not have github_sync when mirror is disabled");

      // 3. Restricted mode: local-only packet + CLI --github-mirror must fail closed
      const packetLocalPath = join(pgmDir, "packet_local.json");
      const packetLocal = {
        schema_version: 1,
        id: "PGM-LOCAL-ATTEMPT",
        title: "Local Attempt Program",
        goal: "Test restricted local mode with explicit mirror",
        status: "design",
        remote_mode: "local-only",
        remote_policy: { repository_slug: "example/fixture" },
        epics: [{ id: "EP-01", title: "Epic", description: "Desc" }],
        tickets: [],
        dependencies: [],
        decisions: [],
      };
      writeFileSync(packetLocalPath, JSON.stringify(packetLocal, null, 2), "utf-8");

      const callsBefore3 = ghCalls.length;
      const res3 = await runIntake(
        {
          command: "intake",
          program: packetLocalPath,
          fromText: "New ticket local",
          title: "Local Ticket",
          write: true,
          githubMirror: true,
        },
        { cwd: tempDir, ghRunner: spyGhRunner, env: {} }
      );

      assert.equal(ghCalls.length - callsBefore3, 0, "local-only packet with --github-mirror must make 0 gh calls");
      assert.equal(res3.candidate_ticket?.github_sync, undefined, "local-only packet ticket must not record github_sync");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test("runDeferral preserves explicit mirror options and forwards validated authority", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "program-mgr-defer-"));
    try {
      const pgmDir = join(tempDir, "plans", "programs", "test-defer-program");
      mkdirSync(pgmDir, { recursive: true });
      const packetPath = join(pgmDir, "program_packet.json");

      const childPlanRel = "plans/plan_child_abandoned";
      const childPlanDir = join(tempDir, childPlanRel);
      mkdirSync(childPlanDir, { recursive: true });
      writeFileSync(join(childPlanDir, "state.json"), JSON.stringify({
        schema_version: 1,
        plan_id: "plan_child_abandoned",
        state: "CLOSE",
        transitions: [{ marker: "[ABANDONED]", gate: "validate-to-close" }],
      }, null, 2));

      function setupPacket() {
        const packet = {
          version: 1,
          schema_version: 1,
          id: "PGM-DEFER-TEST",
          title: "Test Program Deferral",
          goal: "Validate deferral mirroring authority boundaries",
          status: "in_progress",
          policy: { github_mirror: false },
          remote_policy: { mode: "remote-sync", repository_slug: "mock/remote-repo" },
          epics: [{ id: "EP-001", title: "Epic 1", description: "Epic description", story_refs: ["US-001"] }],
          tickets: [{
            id: "T-001",
            title: "Ticket to defer",
            lifecycle: "in_progress",
            epic_id: "EP-001",
            story_refs: ["US-001"],
            child_plan: { plan_dir: childPlanRel },
            github_sync: { published_issue_number: 42, status: "synced" },
          }],
          acceptance_criteria: [],
          compatibility_contracts: [],
          migration_boundaries: [],
          deletion_move_census: [],
          verification_matrix: [],
          dependencies: [],
          decisions: [],
        };
        writeFileSync(packetPath, JSON.stringify(packet, null, 2), "utf-8");
      }

      let ghCalls = [];
      const spyGhRunner = (args) => {
        ghCalls.push(args);
        return { ok: true, status: 0, stdout: "", stderr: "" };
      };

      // 1. Explicit enablement: packet has policy.github_mirror=false, but CLI passes githubMirror=true in remote-sync
      setupPacket();
      ghCalls = [];
      const resEnabled = runDeferral(
        {
          command: "defer",
          program: "test-defer-program",
          ticket: "T-001",
          decision: "DEC-001",
          reason: "Postponing ticket until dependency resolution is reached",
          childPlan: childPlanRel,
          write: true,
          repo: "mock/remote-repo",
          remoteMode: "remote-sync",
          githubMirror: true,
        },
        { cwd: tempDir, ghRunner: spyGhRunner, env: {} }
      );

      assert.equal(resEnabled.status, "PASS");
      assert.equal(resEnabled.action, "deferred");
      assert.equal(ghCalls.length, 1, "runDeferral with explicit githubMirror=true in remote-sync must invoke ghRunner");
      assert.deepEqual(
        ghCalls[0],
        ["issue", "edit", "42", "--repo", "mock/remote-repo", "--add-label", "lifecycle:deferred"],
        "ghRunner must receive expected issue edit command"
      );

      // 2. Explicit disablement: CLI passes githubMirror=false
      setupPacket();
      ghCalls = [];
      const resDisabled = runDeferral(
        {
          command: "defer",
          program: "test-defer-program",
          ticket: "T-001",
          decision: "DEC-002",
          reason: "Postponing ticket until dependency resolution is reached",
          childPlan: childPlanRel,
          write: true,
          repo: "mock/remote-repo",
          remoteMode: "remote-sync",
          githubMirror: false,
        },
        { cwd: tempDir, ghRunner: spyGhRunner, env: {} }
      );

      assert.equal(resDisabled.status, "PASS");
      assert.equal(ghCalls.length, 0, "runDeferral with explicit githubMirror=false must make 0 gh calls");

      // 3. Local-only mode: CLI passes remoteMode="local-only" with githubMirror=true
      setupPacket();
      ghCalls = [];
      const resLocal = runDeferral(
        {
          command: "defer",
          program: "test-defer-program",
          ticket: "T-001",
          decision: "DEC-003",
          reason: "Postponing ticket until dependency resolution is reached",
          childPlan: childPlanRel,
          write: true,
          repo: "mock/remote-repo",
          remoteMode: "local-only",
          githubMirror: true,
        },
        { cwd: tempDir, ghRunner: spyGhRunner, env: {} }
      );

      assert.equal(resLocal.status, "PASS");
      assert.equal(ghCalls.length, 0, "runDeferral in local-only mode must make 0 gh calls");

      // 4. Remote-read mode: CLI passes remoteMode="remote-read" with githubMirror=true
      setupPacket();
      ghCalls = [];
      const resRead = runDeferral(
        {
          command: "defer",
          program: "test-defer-program",
          ticket: "T-001",
          decision: "DEC-004",
          reason: "Postponing ticket until dependency resolution is reached",
          childPlan: childPlanRel,
          write: true,
          repo: "mock/remote-repo",
          remoteMode: "remote-read",
          githubMirror: true,
        },
        { cwd: tempDir, ghRunner: spyGhRunner, env: {} }
      );

      assert.equal(resRead.status, "PASS");
      assert.equal(ghCalls.length, 0, "runDeferral in remote-read mode must make 0 gh calls");

      // 5. Malformed remote mode rejection
      setupPacket();
      ghCalls = [];
      assert.throws(
        () => {
          runDeferral(
            {
              command: "defer",
              program: "test-defer-program",
              ticket: "T-001",
              decision: "DEC-005",
              reason: "Postponing ticket until dependency resolution is reached",
              childPlan: childPlanRel,
              write: true,
              repo: "mock/remote-repo",
              remoteMode: "invalid-mode",
              githubMirror: true,
            },
            { cwd: tempDir, ghRunner: spyGhRunner, env: {} }
          );
        },
        /Unsupported remote mode: invalid-mode/,
        "runDeferral must reject malformed remote mode with clear error"
      );
      assert.equal(ghCalls.length, 0, "runDeferral with malformed mode must make 0 gh calls");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
