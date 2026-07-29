#!/usr/bin/env node
// test_app_dev_tesseract_pack.mjs - app-dev tesseract pack checker coverage.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import {
  APP_DEV_TESSERACT_CHECK_IDS,
  scanAppDevTesseractProject,
} from "../scripts/lib/app_dev_tesseract_pack.mjs";
import { loadKnowledgePacks } from "../scripts/lib/ive_profile_packs.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}`);
  }
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function write(path, text) {
  ensureDir(dirname(path));
  writeFileSync(path, text);
}

function writeJson(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createProject(name) {
  return mkdtempSync(join(tmpdir(), name));
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}

function check(report, id) {
  return (report.checks || []).find((entry) => entry.id === id) || null;
}

function findingCodes(report) {
  return new Set((report.findings || []).map((entry) => entry.code));
}

function packResult(report, packId) {
  return (report.pack_results || []).find((entry) => entry.pack_id === packId) || null;
}

console.log("\nApp-Dev Tesseract Pack Tests\n");

function testGoldenProjectPasses() {
  const tmp = createProject("app-dev-tesseract-golden-");
  try {
    writeJson(join(tmp, "package.json"), { name: "golden-app", dependencies: { express: "^4.0.0" } });
    write(join(tmp, "src/config.js"), "export const webhookSecret = process.env.WEBHOOK_SECRET;\n");
    write(join(tmp, "src/dashboard.js"), [
      "export async function loadDashboard(setState) {",
      "  setState({ loading: true, error: null, empty: false });",
      "  try {",
      "    const response = await fetch('/api/items');",
      "    if (!response.ok) throw new Error('failed request');",
      "    const items = await response.json();",
      "    setState({ loading: false, error: null, empty: items.length === 0, items });",
      "  } catch (error) {",
      "    setState({ loading: false, error, empty: false });",
      "  }",
      "}",
    ].join("\n"));
    write(join(tmp, "src/webhook.js"), [
      "export function installRoutes(app, config) {",
      "  app.post('/webhook/provider', async (req, res) => {",
      "    verifySignature(req.headers.signature, config.webhookSecret);",
      "    const event_id = req.body.id;",
      "    await idempotencyLock(event_id);",
      "    await retryWithBackoff(() => handleDelivery(req.body));",
      "    return res.json({ ok: true });",
      "  });",
      "}",
    ].join("\n"));
    write(join(tmp, "scripts/migrate-users.js"), [
      "export function migrateUsers({ dryRun }) {",
      "  // dry-run, rollback, checkpoint, before/after journey verification.",
      "  return { dryRun, rollback: true, checkpoint: 'verified', idempotent: true };",
      "}",
    ].join("\n"));

    const report = scanAppDevTesseractProject({ rootDir: tmp });
    assert(report.status === "PASS", "golden app-dev project passes");
    assert(report.files_scanned >= 4, "golden scan reads project files");
    assert(check(report, APP_DEV_TESSERACT_CHECK_IDS.ASYNC_STATE)?.status === "PASS", "golden async state check passes");
    assert(check(report, APP_DEV_TESSERACT_CHECK_IDS.ENV_SINGLE_OWNER)?.status === "PASS", "golden env owner check passes");
    assert(check(report, APP_DEV_TESSERACT_CHECK_IDS.WEBHOOK_DELIVERY)?.status === "PASS", "golden webhook delivery check passes");
    assert(check(report, APP_DEV_TESSERACT_CHECK_IDS.MIGRATION_JOURNEY)?.status === "PASS", "golden migration journey check passes");
  } finally {
    cleanup(tmp);
  }
}

function testMissingAsyncErrorStateFails() {
  const tmp = createProject("app-dev-tesseract-async-defect-");
  try {
    write(join(tmp, "assets/app.js"), [
      "export function load(){",
      "  const loading = true;",
      "  const empty = false;",
      "  return fetch('/api/items').then((response) => response.json()).then(render);",
      "}",
    ].join("\n"));
    const report = scanAppDevTesseractProject({ rootDir: tmp });
    assert(report.status === "FAIL", "missing async error state fails");
    assert(findingCodes(report).has("missing_async_error_state"), "missing async error state finding is present");
  } finally {
    cleanup(tmp);
  }
}

function testDuplicateEnvReadFails() {
  const tmp = createProject("app-dev-tesseract-env-defect-");
  try {
    write(join(tmp, "src/config-a.js"), "export const keyA = process.env.API_KEY;\n");
    write(join(tmp, "src/config-b.js"), "export const keyB = process.env.API_KEY;\n");
    const report = scanAppDevTesseractProject({ rootDir: tmp });
    assert(report.status === "FAIL", "duplicate env read fails");
    assert(findingCodes(report).has("duplicate_env_read"), "duplicate env read finding is present");
  } finally {
    cleanup(tmp);
  }
}

function testWebhookMissingDeliveryFails() {
  const tmp = createProject("app-dev-tesseract-webhook-defect-");
  try {
    write(join(tmp, "src/webhook.js"), [
      "export function install(app) {",
      "  app.post('/webhook/provider', (req, res) => res.json({ ok: true }));",
      "}",
    ].join("\n"));
    const report = scanAppDevTesseractProject({ rootDir: tmp });
    assert(report.status === "FAIL", "webhook missing delivery semantics fails");
    assert(findingCodes(report).has("webhook_missing_delivery_semantics"), "webhook delivery finding is present");
  } finally {
    cleanup(tmp);
  }
}

function testMigrationMissingJourneyFails() {
  const tmp = createProject("app-dev-tesseract-migration-defect-");
  try {
    write(join(tmp, "migrations/001_add_member_flags.js"), "export function migrate(db) { return db.alterTable('members'); }\n");
    const report = scanAppDevTesseractProject({ rootDir: tmp });
    assert(report.status === "FAIL", "migration without journey proof fails");
    assert(findingCodes(report).has("migration_missing_journey_proof"), "migration journey finding is present");
  } finally {
    cleanup(tmp);
  }
}

function testKnowledgePackActivation() {
  const tmp = createProject("app-dev-tesseract-loader-");
  try {
    write(join(tmp, "tesseract_operator/api/webhook.py"), "def handle_webhook(request):\n    return {'ok': True}\n");
    const report = loadKnowledgePacks({ cwd: tmp, skillDir, activeProfiles: [] });
    const appPack = packResult(report, "app_dev_tesseract");
    assert(report.ok && appPack?.status === "PASS", "app_dev_tesseract knowledge pack activates from tesseract-family files");
    assert((appPack?.entry_count || 0) >= 8, "app_dev_tesseract pack loads pitfalls and constraints");
    assert((appPack?.obligation_count || 0) >= 4, "app_dev_tesseract pack loads obligations");
    assert((report.facts || []).some((fact) => fact.includes("knowledge_pack_loaded('app_dev_tesseract'")), "app_dev_tesseract emits loaded fact");
  } finally {
    cleanup(tmp);
  }
}

testGoldenProjectPasses();
testMissingAsyncErrorStateFails();
testDuplicateEnvReadFails();
testWebhookMissingDeliveryFails();
testMigrationMissingJourneyFails();
testKnowledgePackActivation();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
