"""Capture focused screenshots of the new v1 panels at 1440x1000."""
from playwright.sync_api import sync_playwright

OUT = "scratch/browser_evidence/v1_panels"

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto("http://127.0.0.1:8791/")
    page.wait_for_selector("#run-button:not([disabled])", timeout=15000)
    page.click("#run-button")
    import time
    deadline = time.time() + 60
    while page.eval_on_selector("#status-pill", "el => el.dataset.state") != "success":
        if time.time() > deadline:
            raise RuntimeError("timeout")
        page.wait_for_timeout(500)
    page.eval_on_selector("#v1-band-title", "el => el.scrollIntoView({block: 'start'})")
    page.wait_for_timeout(300)
    page.screenshot(path=f"{OUT}/band_1440.png")
    page.eval_on_selector("#v1-histogram-title", "el => el.scrollIntoView({block: 'start'})")
    page.wait_for_timeout(300)
    page.screenshot(path=f"{OUT}/histogram_percentile_1440.png")
    # undeclared column view of the band panel
    undeclared = page.eval_on_selector(
        "#metric-select",
        "el => Array.from(el.querySelectorAll('option')).map(o => o.value).filter(v => v.startsWith('column:'))",
    )
    page.select_option("#metric-select", undeclared[2])
    page.wait_for_timeout(300)
    page.eval_on_selector("#v1-band-title", "el => el.scrollIntoView({block: 'start'})")
    page.wait_for_timeout(300)
    page.screenshot(path=f"{OUT}/band_undeclared_1440.png")
    print("errors:", errors)
    browser.close()
