#!/usr/bin/env node
// test_frontend_journey_conformance.mjs — Browser/frontend automation conformance.
//
// T-INTAKE-2C7A79A9: Add a Playwright-based conformance suite that exercises a
// real frontend journey and captures screenshot proof.
//
// Residual unverified risks when local browser tooling is unavailable:
//   - This suite can validate DOM state, screenshot rendering, and basic
//     accessibility only when Playwright + a Chromium browser are installed.
//   - If Playwright or the browser is missing, the suite exits cleanly with a
//     SKIP message. In that environment, no real rendering proof is produced,
//     so ux_ui/browser regression coverage is deferred until CI or a machine
//     with browsers installed runs the suite.
//   - Interactive behaviors (hover, focus rings, responsive breakpoints) are
//     not exercised here; this test covers loading/success/error/empty states
//     on a single viewport.

import { createServer } from "http";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const visualizerRoot = join(repoRoot, "apps", "ive-visualizer");
const fixtureRoot = join(testDir, "fixtures", "frontend_journey");

const SCREENSHOT_DIR = resolve(repoRoot, "reports", "ive_visualizer", "frontend_journey_conformance");
const HTTP_PORT = 0; // let the OS assign a free port
const TIMEOUT_MS = 30_000;

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}`);
  }
}

function logSkip(reason) {
  skipped += 1;
  console.log(`  SKIP: ${reason}`);
}

async function resolvePlaywright() {
  // Prefer the visualizer's local Playwright install.
  try {
    const visualizerPlaywright = join(visualizerRoot, "node_modules", "playwright", "index.mjs");
    if (existsSync(visualizerPlaywright)) {
      return import(visualizerPlaywright);
    }
  } catch {
    // fall through
  }

  // Fallback to a Node-resolution from the test directory.
  try {
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    const modulePath = require.resolve("playwright");
    return import(modulePath);
  } catch {
    // fall through
  }

  return null;
}

function startStaticServer(root, port = HTTP_PORT) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      let filePath = resolve(join(root, decodeURIComponent(url.pathname)));
      // Disallow paths outside the fixture root.
      if (!filePath.startsWith(root)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      if (filePath.endsWith("/")) {
        filePath = join(filePath, "dashboard.html");
      }
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      // Using readFileSync is acceptable for a tiny conformance fixture.
      res.end(readFileSync(filePath));
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolvePromise({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function main() {
  console.log("\nFrontend Journey Conformance Tests\n");

  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const playwrightModule = await resolvePlaywright();
  if (!playwrightModule || !playwrightModule.chromium) {
    logSkip(
      "Playwright not available. Install browsers with: " +
      "npm ci --prefix apps/ive-visualizer && npm --prefix apps/ive-visualizer exec playwright -- install --with-deps chromium"
    );
    console.log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped`);
    process.exit(0);
  }

  const { chromium } = playwrightModule;

  let browser;
  let server;
  try {
    browser = await chromium.launch({ headless: true, timeout: TIMEOUT_MS });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    const serverInfo = await startStaticServer(fixtureRoot);
    server = serverInfo.server;
    const baseUrl = serverInfo.url;

    // Happy path: load data and verify rendered content.
    await page.goto(`${baseUrl}/dashboard.html`);
    await page.getByRole("button", { name: "Load data" }).click();
    await page.waitForSelector('[data-testid="success-state"]');
    assert(await page.isVisible('[data-testid="success-state"]'), "success state is visible after loading data");
    const itemCount = await page.locator('[data-testid="data-item"]').count();
    assert(itemCount === 3, `success state renders 3 data items (got ${itemCount})`);

    await page.screenshot({ path: join(SCREENSHOT_DIR, "frontend-journey-success.png"), fullPage: true });

    // Error/empty-state path.
    await page.getByRole("button", { name: "Trigger error" }).click();
    await page.waitForSelector('[data-testid="error-state"]');
    assert(await page.isVisible('[data-testid="error-state"]'), "error state is visible after trigger");
    const errorText = await page.textContent('[data-testid="error-state"]');
    assert(errorText.includes("Failed to fetch"), "error state shows a meaningful message");

    await page.screenshot({ path: join(SCREENSHOT_DIR, "frontend-journey-error.png"), fullPage: true });

    await page.getByRole("button", { name: "Show empty" }).click();
    await page.waitForSelector('[data-testid="empty-state"]');
    assert(await page.isVisible('[data-testid="empty-state"]'), "empty state is visible");

    await page.screenshot({ path: join(SCREENSHOT_DIR, "frontend-journey-empty.png"), fullPage: true });

    // Loading state is a quick transient check.
    await page.getByRole("button", { name: "Show loading" }).click();
    await page.waitForSelector('[data-testid="loading-state"]');
    assert(await page.isVisible('[data-testid="loading-state"]'), "loading state is visible");

    await context.close();
  } catch (err) {
    failed += 1;
    console.log(`  FAIL: unexpected error — ${err.message}`);
    if (err.stack) console.log(err.stack.split("\n").slice(0, 4).join("\n"));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
