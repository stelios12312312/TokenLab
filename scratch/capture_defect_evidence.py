#!/usr/bin/env python3
"""Capture browser evidence for the gallery defect fixes.

Screenshots at 1440×1000 (desktop) and 390×844 (mobile) for:
- growth-path (deterministic, multiple paths)
- z1-solvency-adapted-v1 (single path / adapted)

Run with: scratch/browser_venv/bin/python scratch/capture_defect_evidence.py
"""

import json
import socket
import subprocess
import sys
import time
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EVIDENCE = ROOT / "scratch" / "browser_evidence" / "defect_fixes"
RUNS_DIR = EVIDENCE / "gallery-runs"
SYSTEM_PYTHON = "python3"

from playwright.sync_api import sync_playwright  # noqa: E402


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def start_server(port):
    code = (
        "import sys; sys.path.insert(0, 'src');"
        "from TokenLab.dashboard import create_gallery_server;"
        f"srv = create_gallery_server({str(RUNS_DIR)!r}, host='127.0.0.1', port={port});"
        "print('READY', srv.server_port, flush=True);"
        "srv.serve_forever()"
    )
    proc = subprocess.Popen(
        [SYSTEM_PYTHON, "-c", code],
        cwd=str(ROOT),
        env={**dict(os.environ), "MPLBACKEND": "Agg", "PYTHONPATH": "src:."},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    deadline = time.time() + 15
    while time.time() < deadline:
        line = proc.stdout.readline().decode().strip()
        if line.startswith("READY"):
            return proc
    raise RuntimeError("server failed to start")


def capture_demo(page, base_url, demo_id, viewport_name, width, height):
    """Load a demo and capture full-page screenshot."""
    page.set_viewport_size({"width": width, "height": height})
    page.goto(base_url, wait_until="networkidle")
    page.wait_for_timeout(500)

    # Click the demo in the sidebar
    demo_link = page.locator(f'[data-demo="{demo_id}"]')
    if demo_link.count() > 0:
        demo_link.first.click()
        page.wait_for_timeout(500)
    else:
        print(f"  [WARN] demo link '{demo_id}' not found, taking page screenshot anyway")

    # For deterministic demos, click "Run simulation" if available
    run_btn = page.locator("button", has_text="Run simulation")
    if run_btn.count() > 0 and run_btn.first.is_visible():
        run_btn.first.click()
        page.wait_for_timeout(3000)
        try:
            page.wait_for_function(
                "() => document.querySelector('.status-pill')?.textContent?.match(/success|Validated|ready/i)",
                timeout=15000,
            )
        except Exception:
            pass

    page.wait_for_timeout(500)
    filename = f"{demo_id}_{viewport_name}.png"
    filepath = EVIDENCE / filename
    page.screenshot(path=str(filepath), full_page=True)
    print(f"  [{viewport_name}] saved: {filepath.name}")
    return filepath


def main():
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    port = free_port()
    proc = start_server(port)
    base_url = f"http://127.0.0.1:{port}"
    print(f"Server at {base_url}")
    errors = []

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)

            demos = [
                "growth-path",
                "z1-solvency-adapted-v1",
            ]
            viewports = [
                ("desktop_1440x1000", 1440, 1000),
                ("mobile_390x844", 390, 844),
            ]

            for demo_id in demos:
                for vp_name, w, h in viewports:
                    try:
                        ctx = browser.new_context(viewport={"width": w, "height": h})
                        page = ctx.new_page()
                        console_errors = []
                        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
                        capture_demo(page, base_url, demo_id, vp_name, w, h)
                        if console_errors:
                            print(f"  [WARN] console errors: {console_errors}")
                            errors.extend(console_errors)
                        ctx.close()
                    except Exception as e:
                        print(f"  [ERROR] {demo_id}/{vp_name}: {e}")
                        errors.append(str(e))

            browser.close()
    finally:
        proc.terminate()
        proc.wait(5)

    report = EVIDENCE / "EVIDENCE.md"
    with open(report, "w") as f:
        f.write("# Gallery Defect Fix Evidence\n\n")
        f.write(f"Captured at {time.strftime('%Y-%m-%dT%H:%M:%S')}\n\n")
        for filepath in sorted(EVIDENCE.glob("*.png")):
            f.write(f"## {filepath.stem}\n\n")
            f.write(f"![{filepath.stem}]({filepath.name})\n\n")
        if errors:
            f.write("## Console Errors\n\n")
            for e in errors:
                f.write(f"- {e}\n")
    print(f"\nEvidence report: {report}")
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
