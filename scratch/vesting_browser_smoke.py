"""Browser smoke for the public-vesting-concentrated-v2 demo (plan_2026-08-17_294429c6635af13c sc_7).

Drives the already-running gallery at 127.0.0.1:8791: selects the demand demo,
runs the fast tier, waits for success, asserts key labels and sanitization in
the rendered page, saves screenshots + console/network log.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8791/"
OUT = Path("scratch/browser_evidence/vesting_smoke")
OUT.mkdir(parents=True, exist_ok=True)

results = []
console = []
network = []


def check(name, ok, note=""):
    results.append((name, bool(ok), note))
    print(f"[{'PASS' if ok else 'FAIL'}] {name} :: {note}")


def main() -> int:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.on("console", lambda m: console.append({"type": m.type, "text": m.text}))
        page.on("response", lambda r: network.append({"url": r.url, "status": r.status}))
        page.goto(BASE, wait_until="networkidle")
        page.screenshot(path=OUT / "01_initial.png")

        # Select the demand demo
        page.select_option("#demo-select", value="public-vesting-concentrated-v2")
        page.wait_for_timeout(500)
        page.screenshot(path=OUT / "02_setup.png")

        body = page.inner_text("body")
        check("demo selected shows stochastic setup", "Run Monte Carlo" in body or "mc-run-button" in body or page.locator("#mc-run-button").count() > 0)
        check("no client symbol on page", "MRG" not in body)
        check("no client name on page", "hemergy" not in body.lower())
        check("VTLB symbol visible", "VTLB" in body)

        # Run fast tier
        page.locator("#mc-run-button").click()
        page.wait_for_selector("text=/requested/", timeout=15000)
        page.wait_for_selector("text=/100 completed|100 \/ 100|completed.*100/", timeout=30000)
        page.wait_for_timeout(1000)
        page.screenshot(path=OUT / "03_success.png")
        body = page.inner_text("body")

        check("counts show 100 completed", re.search(r"100\s+(requested|/)\s*.*100\s+completed|completed[^\d]*100", body) is not None or "100 completed" in body)
        check("fan chart label honest", "modeled outcomes: P10" in body)
        check("CI names estimator+method", "percentile-bootstrap confidence interval for the" in body)
        check("non-causal sensitivity note", "association is not causal" in body)
        check("illustrative/uncalibrated boundary", "illustrative" in body.lower() and "uncalibrated" in body.lower())
        bad_ci = re.findall(r"P10[^.]{0,120}confidence interval", body)
        bad_ci = [b for b in bad_ci if "not" not in b.lower() and "never" not in b.lower()]
        check("no outcome percentile mislabeled as CI", not bad_ci, str(bad_ci[:1]))
        check("no client symbol after run", "MRG" not in body)

        errors = [c for c in console if c["type"] == "error"]
        failed = [n for n in network if n["status"] >= 400]
        check("no console errors", not errors, str(errors[:2]))
        check("no failed network responses", not failed, str(failed[:2]))

        (OUT / "console_network.json").write_text(json.dumps({"console": console, "network": network}, indent=1))
        browser.close()

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"SMOKE: {passed}/{len(results)} passed -> {OUT}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
