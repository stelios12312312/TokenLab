"""Smoke check: v1 gallery workspace band/histogram/percentile panels."""
import json
import sys

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8791/"
OUT = "scratch/browser_evidence/v1_panels"

console_errors = []
results = {}

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
    page.on("pageerror", lambda err: console_errors.append(str(err)))
    page.goto(BASE)
    page.wait_for_selector("#run-button:not([disabled])", timeout=15000)

    # Ensure the deterministic growth-path demo is selected
    demo = page.eval_on_selector("#demo-select", "el => el.value")
    results["demo"] = demo

    # Run baseline preset at baseline values
    page.click("#run-button")
    deadline = __import__("time").time() + 60
    while page.eval_on_selector("#status-pill", "el => el.dataset.state") != "success":
        if __import__("time").time() > deadline:
            raise RuntimeError("run did not reach success state")
        page.wait_for_timeout(500)

    selected = page.eval_on_selector("#metric-select", "el => el.value")
    results["declared_selection"] = selected
    results["band_svg_declared"] = page.eval_on_selector(
        "#v1-band-wrap", "el => !!el.querySelector('svg')"
    )
    results["band_legend_declared"] = page.eval_on_selector(
        "#v1-band-legend", "el => el.textContent.trim()"
    )
    results["histogram_svg_declared"] = page.eval_on_selector(
        "#v1-histogram-wrap", "el => !!el.querySelector('svg')"
    )
    results["percentile_rows"] = page.eval_on_selector(
        "#v1-percentile-table", "el => el.querySelectorAll('tbody tr').length"
    )
    results["percentile_caption"] = page.eval_on_selector(
        "#v1-percentile-table", "el => (el.querySelector('caption') || {}).textContent || ''"
    )
    results["band_aria"] = page.eval_on_selector(
        "#v1-band-wrap svg", "el => el.getAttribute('aria-label')"
    )

    page.screenshot(path=f"{OUT}/declared_1440.png", full_page=False)

    # Switch to an undeclared column
    undeclared = page.eval_on_selector(
        "#metric-select",
        "el => Array.from(el.querySelectorAll('option')).map(o => o.value).filter(v => v.startsWith('column:'))",
    )
    results["undeclared_options"] = undeclared[:5]
    if undeclared:
        page.select_option("#metric-select", undeclared[0])
        page.wait_for_timeout(300)
        results["note_visible_undeclared"] = page.eval_on_selector(
            "#metric-select-note", "el => !el.hidden && el.textContent.includes('descriptive only')"
        )
        results["band_svg_undeclared"] = page.eval_on_selector(
            "#v1-band-wrap", "el => !!el.querySelector('svg')"
        )
        results["histogram_svg_undeclared"] = page.eval_on_selector(
            "#v1-histogram-wrap", "el => !!el.querySelector('svg')"
        )
        results["histogram_caption_undeclared"] = page.eval_on_selector(
            "#v1-histogram-wrap svg",
            "el => Array.from(el.querySelectorAll('text')).map(t => t.textContent).join(' | ')",
        )
        page.screenshot(path=f"{OUT}/undeclared_1440.png", full_page=False)

    # No Monte Carlo / confidence language anywhere in the v1 workspace
    v1_text = page.eval_on_selector("#v1-workspace", "el => el.textContent")
    results["mc_language_leak"] = [
        phrase for phrase in ("Monte Carlo outcome interval", "confidence band", "confidence interval")
        if phrase in v1_text and "never a Monte Carlo" not in v1_text.split(phrase)[0][-60:]
    ]
    # simpler: check the band legend itself
    results["legend_has_honest_label"] = "deterministic" in results["band_legend_declared"]

    # Mobile viewport
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(300)
    page.select_option("#metric-select", selected)
    page.wait_for_timeout(200)
    page.screenshot(path=f"{OUT}/declared_390.png", full_page=False)
    results["mobile_band_svg"] = page.eval_on_selector(
        "#v1-band-wrap", "el => !!el.querySelector('svg')"
    )

    # Keyboard focusability: tab to metric-select and change via keyboard
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.focus("#metric-select")
    results["metric_select_focusable"] = page.evaluate(
        "document.activeElement.id === 'metric-select'"
    )

    browser.close()

results["console_errors"] = console_errors
print(json.dumps(results, indent=2))
sys.exit(1 if console_errors else 0)
