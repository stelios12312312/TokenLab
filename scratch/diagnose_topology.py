#!/usr/bin/env python3
"""Diagnose topology panel clipping + layout geometry on the running gallery."""
import json
import sys
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8791"

JS = """() => {
  const out = {};
  const el = (s) => document.querySelector(s);
  const rect = (e) => e ? {x: e.x, y: e.y, w: e.width, h: e.height} : null;
  out.scrollY = window.scrollY;
  out.viewport = {w: innerWidth, h: innerHeight};
  for (const [k, s] of Object.entries({
    panel: '#topology-panel',
    toolbar: '#topology-panel .chart-toolbar',
    title: '#topology-title',
    copy: '#topology-copy',
    wrap: '#topology-wrap',
    setup: '.setup',
    main: 'main',
  })) {
    const e = el(s);
    if (!e) { out[k] = null; continue; }
    const cs = getComputedStyle(e);
    out[k] = {rect: rect(e.getBoundingClientRect()),
              pos: cs.position, zIndex: cs.zIndex, overflow: cs.overflow,
              display: cs.display, gridColumn: cs.gridColumn, transform: cs.transform};
  }
  const t = el('#topology-title');
  if (t) {
    const r = t.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + Math.min(r.height / 2, 10);
    const hit = document.elementFromPoint(cx, cy);
    out.hitAtTitle = hit ? hit.tagName + '.' + hit.className + ' #' + hit.id : null;
    const hit2 = document.elementFromPoint(r.left + 4, r.top + 4);
    out.hitAtTitleCorner = hit2 ? hit2.tagName + '.' + hit2.className + ' #' + hit2.id : null;
  }
  const c = el('#topology-copy');
  if (c) {
    const r = c.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    out.hitAtCopy = hit ? hit.tagName + '.' + hit.className + ' #' + hit.id : null;
  }
  // which grid row does the panel occupy?
  const main = el('main');
  out.mainChildren = Array.from(main.children).map(ch => ({
    tag: ch.tagName, cls: ch.className, id: ch.id, hidden: ch.hidden,
    y: ch.getBoundingClientRect().y, h: ch.getBoundingClientRect().height}));
  return out;
}"""


def main():
    demo = sys.argv[1] if len(sys.argv) > 1 else "public-vesting-concentrated-v2"
    width = int(sys.argv[2]) if len(sys.argv) > 2 else 1440
    height = int(sys.argv[3]) if len(sys.argv) > 3 else 1000
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_context(viewport={"width": width, "height": height}).new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_selector("#demo-select:not([disabled])", timeout=15000)
        page.select_option("#demo-select", demo)
        page.wait_for_selector("#topology-panel:not([hidden])", timeout=10000)
        page.wait_for_timeout(400)
        # scroll to the topology panel
        page.evaluate("document.querySelector('#topology-panel').scrollIntoView({block:'center'})")
        page.wait_for_timeout(300)
        info = page.evaluate(JS)
        print(json.dumps({"at_center": info}, indent=1))
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        page.wait_for_timeout(300)
        info2 = page.evaluate(JS)
        print(json.dumps({"at_bottom": info2}, indent=1))
        print("CONSOLE ERRORS:", errors)
        browser.close()


if __name__ == "__main__":
    main()
