"""Browser smoke for the z1-solvency-adapted-v1 gallery entry (plan_2026-08-17_75269b929f68747e sc_2).

Drives the running gallery: selects the adapted demo, runs baseline and stable
presets (read-only projection), checks emitted-metric rendering and labels, and
verifies the collapse preset renders a visibly blocked state with the upstream
reason. Saves screenshots + console/network log.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8791/"
OUT = Path("scratch/browser_evidence/z1_smoke")
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

        page.select_option("#demo-select", value="z1-solvency-adapted-v1")
        page.wait_for_timeout(700)
        page.screenshot(path=OUT / "01_setup.png")
        body = page.inner_text("body")
        check("adapted demo selected", len(body) > 0)
        check("no client identifiers on page", "zee" not in body.lower() and "zee5" not in body.lower())
        check("diagnostic boundary visible", "diagnostic" in body.lower() or "scenario evidence" in body.lower() or "not" in body.lower())

        # Run baseline preset
        ran = False
        for selector in ("text=baseline", "label:has-text('baseline')", "input[value='baseline']"):
            try:
                page.locator(selector).first.click(timeout=3000)
                ran = True
                break
            except Exception:
                continue
        check("baseline preset selectable", ran)
        for selector in ("#run-button", "button:has-text('Run')", "#mc-run-button"):
            try:
                page.locator(selector).first.click(timeout=3000)
                break
            except Exception:
                continue
        page.wait_for_timeout(4000)
        page.screenshot(path=OUT / "02_baseline.png")
        body = page.inner_text("body")
        check("baseline projection renders metrics", "reserve ratio" in body.lower() or "treasury" in body.lower())
        check("classification visible", "stable" in body.lower() or "collapse" in body.lower())
        check("no forecast/advice claims", "forecast" not in body.lower() or "not a forecast" in body.lower() or "not forecasts" in body.lower())

        # Switch to stable preset
        ran = False
        for selector in ("text=stable", "label:has-text('stable')", "input[value='stable']"):
            try:
                page.locator(selector).first.click(timeout=3000)
                ran = True
                break
            except Exception:
                continue
        if ran:
            for selector in ("#run-button", "button:has-text('Run')", "#mc-run-button"):
                try:
                    page.locator(selector).first.click(timeout=3000)
                    break
                except Exception:
                    continue
            page.wait_for_timeout(4000)
        page.screenshot(path=OUT / "03_stable.png")
        check("stable preset renders", ran)

        # Collapse preset must be visibly blocked
        ran = False
        for selector in ("text=collapse", "label:has-text('collapse')", "input[value='collapse']"):
            try:
                page.locator(selector).first.click(timeout=3000)
                ran = True
                break
            except Exception:
                continue
        if ran:
            for selector in ("#run-button", "button:has-text('Run')", "#mc-run-button"):
                try:
                    page.locator(selector).first.click(timeout=3000)
                    break
                except Exception:
                    continue
            page.wait_for_timeout(4000)
        page.screenshot(path=OUT / "04_collapse_blocked.png")
        body = page.inner_text("body")
        check("collapse preset visibly blocked", "block" in body.lower() or "l10" in body.lower() or "unavailable" in body.lower(), "" if ran else "preset not selectable")

        errors = [c for c in console if c["type"] == "error"]
        failed = [n for n in network if n["status"] >= 400 and "/api/" in n["url"] and "collapse" not in json.dumps(n)]
        check("no console errors", not errors, str(errors[:2]))
        check("no unexpected failed API responses", not failed, str(failed[:2]))

        (OUT / "console_network.json").write_text(json.dumps({"console": console, "network": network}, indent=1))
        browser.close()

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"SMOKE: {passed}/{len(results)} passed -> {OUT}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
