#!/usr/bin/env python3
"""Capture topology panel screenshots + clipping/console checks for all target demos."""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
BASE = "http://127.0.0.1:8791"

DEMOS = [
    ("public-vesting-concentrated-v2", 1440, 1000),
    ("public-growth-uncertainty-v2", 1440, 1000),
    ("public-multitoken-dependency-v3", 1440, 1000),
    ("z1-solvency-adapted-v1", 1440, 1000),
    ("public-vesting-concentrated-v2", 390, 844),
]

CHECK_JS = """() => {
  const el = (s) => document.querySelector(s);
  const out = {scrollY: window.scrollY, vw: innerWidth, vh: innerHeight};
  const setup = el('.setup').getBoundingClientRect();
  const panel = el('#topology-panel').getBoundingClientRect();
  out.setup = {x: setup.x, y: setup.y, w: setup.width, h: setup.height, bottom: setup.bottom};
  out.panel = {x: panel.x, y: panel.y, w: panel.width, h: panel.height};
  const hits = {};
  for (const sel of ['#topology-title', '#topology-copy']) {
    const r = el(sel).getBoundingClientRect();
    const cx = r.left + Math.min(r.width / 2, 200), cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    hits[sel] = {rect: {x: r.x, y: r.y, w: r.width, h: r.height},
                 hit: hit ? (hit.id === sel.slice(1) || el(sel).contains(hit) ? 'SELF' : hit.tagName + '#' + hit.id + '.' + hit.className) : 'OFFSCREEN'};
  }
  out.hits = hits;
  const svg = el('#topology-wrap svg');
  out.svg = svg ? {viewBox: svg.getAttribute('viewBox'), cssWidth: svg.style.width} : null;
  if (svg) {
    const vb = svg.getAttribute('viewBox').split(' ').map(Number);
    out.nodeViolations = Array.from(svg.querySelectorAll('.topology-node rect'))
      .map((r) => ({x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height')}))
      .filter((r) => r.x < vb[0] || r.y < vb[1] || r.x + r.w > vb[0] + vb[2] || r.y + r.h > vb[1] + vb[3]);
    out.nodeCount = svg.querySelectorAll('.topology-node').length;
    out.labelCount = svg.querySelectorAll('text').length;
  }
  out.wrapScroll = (() => { const w = el('#topology-wrap'); return {scrollW: w.scrollWidth, clientW: w.clientWidth}; })();
  return out;
}"""


def main():
    tag = sys.argv[1]  # 'before' or 'after'
    outdir = ROOT / "scratch" / "browser_evidence" / "topology_fix" / tag
    outdir.mkdir(parents=True, exist_ok=True)
    report = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for demo, w, h in DEMOS:
            key = f"{demo}_{w}x{h}"
            page = browser.new_context(viewport={"width": w, "height": h}).new_page()
            errors = []
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(BASE, wait_until="networkidle")
            page.wait_for_selector("#demo-select:not([disabled])", timeout=15000)
            page.select_option("#demo-select", demo)
            page.wait_for_selector("#topology-panel:not([hidden])", timeout=10000)
            page.wait_for_selector("#topology-wrap svg", timeout=10000)
            page.wait_for_timeout(400)
            page.evaluate("document.querySelector('#topology-panel').scrollIntoView({block:'center'})")
            page.wait_for_timeout(300)
            info = page.evaluate(CHECK_JS)
            info["console_errors"] = errors
            report[key] = info
            panel = page.locator("#topology-panel")
            panel.screenshot(path=str(outdir / f"{key}_panel.png"))
            page.locator("#topology-wrap svg").screenshot(path=str(outdir / f"{key}_svg.png"))
            page.screenshot(path=str(outdir / f"{key}_full.png"), full_page=False)
            # also capture the svg scrolled to its left start, full width of wrap
            page.close()
        browser.close()
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
