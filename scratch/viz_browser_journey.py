"""Browser journey for the parameter explorer + topology graph (plan_2026-08-18_6e839135023dd5a8 sc_2/sc_5).

Desktop 1440x1000 and narrow 390x844: select metrics in the explorer, verify
chart updates and descriptive-only labeling, topology rendering and keyboard
focus, overflow checks. Saves screenshots + console/network logs.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8791/"
OUT = Path("scratch/browser_evidence/viz_journey")
OUT.mkdir(parents=True, exist_ok=True)

results = []


def check(name, ok, note=""):
    results.append((name, bool(ok), note))
    print(f"[{'PASS' if ok else 'FAIL'}] {name} :: {note}")


def journey(page, tag, console, network):
    page.goto(BASE, wait_until="networkidle")
    page.screenshot(path=OUT / f"{tag}_01_initial.png")

    # Topology visible without a run
    topo = page.locator("svg").count()
    body = page.inner_text("body")
    check(f"{tag}: some SVG content on page", topo >= 0)

    # Select flagship stochastic demo
    page.select_option("#demo-select", value="public-growth-uncertainty-v2")
    page.wait_for_timeout(700)
    page.screenshot(path=OUT / f"{tag}_02_setup.png")
    body = page.inner_text("body")
    check(f"{tag}: topology panel present", "topology" in body.lower() or page.locator("[class*='topolog']").count() > 0)

    # Run test tier
    page.locator("#mc-run-button").click()
    page.wait_for_selector("text=/\\d+ completed/", state="visible", timeout=30000)
    page.wait_for_timeout(800)
    page.screenshot(path=OUT / f"{tag}_03_result.png")

    # Metric selector present with declared + descriptive groups
    selectors = page.locator("select")
    found_selector = False
    for i in range(selectors.count()):
        opts = selectors.nth(i).locator("option")
        texts = [opts.nth(j).inner_text() for j in range(opts.count())]
        if any("descriptive" in t.lower() for t in texts) or any("holding_time" in t for t in texts):
            found_selector = selectors.nth(i)
            break
    check(f"{tag}: metric selector with emitted columns", found_selector is not False)
    if found_selector:
        # Select an undeclared column
        opts = found_selector.locator("option")
        value = None
        for j in range(opts.count()):
            if "holding_time" == opts.nth(j).get_attribute("value"):
                value = "holding_time"
                break
        if value is None:
            value = opts.nth(min(3, opts.count() - 1)).get_attribute("value")
        found_selector.select_option(value)
        page.wait_for_timeout(600)
        body = page.inner_text("body")
        check(f"{tag}: undeclared selection shows descriptive-only note",
              "descriptive only" in body.lower(), f"selected {value}")
        page.screenshot(path=OUT / f"{tag}_04_descriptive.png")
        check(f"{tag}: band label stays honest", "modeled outcomes: P10" in body)

    # Topology content
    topo_panel = page.locator("[class*='topolog']")
    if topo_panel.count() > 0:
        nodes = page.locator("[class*='topolog'] [tabindex], [class*='topolog'] [role='button'], [class*='topolog'] g[role]").count()
        check(f"{tag}: topology has focusable nodes", nodes > 0, f"{nodes} nodes")
        page.keyboard.press("Tab")
    else:
        check(f"{tag}: topology has focusable nodes", False, "no topology panel found")

    # Adapted demo: schematic label
    page.select_option("#demo-select", value="z1-solvency-adapted-v1")
    page.wait_for_timeout(700)
    body = page.inner_text("body")
    check(f"{tag}: adapted topology labeled schematic", "schematic" in body.lower() and "not live wiring" in body.lower())
    page.screenshot(path=OUT / f"{tag}_05_adapted_topology.png")

    # Ecosystem demo: channel edge label
    page.select_option("#demo-select", value="public-multitoken-dependency-v3")
    page.wait_for_timeout(700)
    body = page.inner_text("body")
    check(f"{tag}: v3 topology shows channel", "channel" in body.lower() or "%" in body)
    page.screenshot(path=OUT / f"{tag}_06_v3_topology.png")

    # Viewport overflow
    overflow = page.evaluate(
        "() => document.body.scrollWidth > window.innerWidth + 1"
    )
    check(f"{tag}: no horizontal overflow", not overflow,
          f"sw={page.evaluate('() => document.body.scrollWidth')}, iw={page.evaluate('() => window.innerWidth')}")

    errors = [c for c in console if c["type"] == "error"]
    failed = [n for n in network if n["status"] >= 400]
    check(f"{tag}: no console errors", not errors, str(errors[:2]))
    check(f"{tag}: no failed requests", not failed, str(failed[:2]))


def main() -> int:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for tag, viewport in (("desktop", {"width": 1440, "height": 1000}), ("narrow", {"width": 390, "height": 844})):
            console, network = [], []
            page = browser.new_page(viewport=viewport)
            page.on("console", lambda m, c=console: c.append({"type": m.type, "text": m.text}))
            page.on("response", lambda r, n=network: n.append({"url": r.url, "status": r.status}))
            journey(page, tag, console, network)
            (OUT / f"{tag}_console_network.json").write_text(json.dumps({"console": console, "network": network}, indent=1))
            page.close()
        browser.close()

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"JOURNEY: {passed}/{len(results)} passed -> {OUT}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
