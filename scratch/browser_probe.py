#!/usr/bin/env python3
"""Probe: diagnose download-click interception (desktop) and narrow overflow."""
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EVIDENCE = ROOT / "scratch" / "browser_evidence"
from playwright.sync_api import sync_playwright


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]; s.close(); return p


def start_server(port):
    code = (
        "import sys; sys.path.insert(0, 'src');"
        "from TokenLab.dashboard import create_gallery_server;"
        f"srv = create_gallery_server({str(EVIDENCE / 'gallery-runs')!r}, host='127.0.0.1', port={port});"
        "print('READY', srv.server_port, flush=True); srv.serve_forever()")
    proc = subprocess.Popen(["python3", "-c", code], cwd=ROOT,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    deadline = time.time() + 60
    while time.time() < deadline:
        line = proc.stdout.readline()
        if line.startswith("READY"):
            return proc, int(line.split()[1])
    raise RuntimeError("server not ready")


def prep(page, base_url):
    page.goto(base_url, wait_until="networkidle")
    page.wait_for_selector("#demo-select:not([disabled])", timeout=15000)
    page.select_option("#demo-select", "public-growth-uncertainty-v2")
    page.wait_for_selector("#stochastic-setup:not([hidden])", timeout=10000)
    page.select_option("#tier-select", "fast")
    page.click("#mc-run-button")
    page.wait_for_selector('#status-pill[data-state="success"]', timeout=120000)
    page.wait_for_timeout(600)


def main():
    port = free_port()
    proc, actual = start_server(port)
    base = f"http://127.0.0.1:{actual}"
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            # desktop probe
            page = browser.new_context(viewport={"width": 1440, "height": 1000}).new_page()
            prep(page, base)
            info = page.evaluate("""() => {
              const a = document.querySelector('#mc-downloads a.download');
              const r = a.getBoundingClientRect();
              const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
              const el = document.elementFromPoint(cx, cy);
              const chain = [];
              let n = el;
              while (n && chain.length < 6) { chain.push(n.tagName + '#' + (n.id||'') + '.' + (n.className||'')); n = n.parentElement; }
              const setup = document.querySelector('.setup').getBoundingClientRect();
              const ws = document.getElementById('stochastic-workspace').getBoundingClientRect();
              return {anchor: {x: r.x, y: r.y, w: r.width, h: r.height},
                      center: [cx, cy], hit: chain, setupRect: {x: setup.x, w: setup.width},
                      workspaceRect: {x: ws.x, w: ws.width}, iw: window.innerWidth};
            }""")
            print("DESKTOP-DOWNLOAD-PROBE", json.dumps(info, indent=1))
            # also after scrolling the anchor into view (mimic playwright)
            page.evaluate("() => document.querySelector('#mc-downloads a.download').scrollIntoView({block:'center'})")
            page.wait_for_timeout(200)
            info2 = page.evaluate("""() => {
              const a = document.querySelector('#mc-downloads a.download');
              const r = a.getBoundingClientRect();
              const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
              const el = document.elementFromPoint(cx, cy);
              const chain = [];
              let n = el;
              while (n && chain.length < 6) { chain.push(n.tagName + '#' + (n.id||'') + '.' + (n.className||'')); n = n.parentElement; }
              return {center: [cx, cy], hit: chain, scrollY: window.scrollY, vh: window.innerHeight};
            }""")
            print("DESKTOP-DOWNLOAD-PROBE-SCROLLED", json.dumps(info2, indent=1))
            page.screenshot(path=str(EVIDENCE / "probe_download_scrolled.png"))
            page.context.close()

            # narrow probe: find widest offenders
            page = browser.new_context(viewport={"width": 390, "height": 844}).new_page()
            prep(page, base)
            wide = page.evaluate("""() => {
              const iw = window.innerWidth;
              const out = [];
              document.querySelectorAll('body *').forEach(el => {
                const r = el.getBoundingClientRect();
                if (r.width > iw + 1 || el.scrollWidth > iw + 1) {
                  out.push({sel: el.tagName + '#' + (el.id||'') + '.' + String(el.className).slice(0,40),
                            w: Math.round(r.width), sw: el.scrollWidth,
                            text: (el.childNodes.length && el.children.length===0) ? el.textContent.slice(0,60) : ''});
                }
              });
              return out.slice(0, 30);
            }""")
            print("NARROW-WIDE-ELEMENTS", json.dumps(wide, indent=1))
            page.context.close()
            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
