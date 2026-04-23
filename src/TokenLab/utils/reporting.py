"""
TokenLab HTML Report Generator
==============================

A general-purpose, self-contained HTML report builder for any TokenLab simulation.
Produces a single .html file with embedded base64 plots, professional dark-theme
styling, tabbed navigation, and responsive layout.

Usage
-----
    from TokenLab.utils.reporting import ReportBuilder

    report = ReportBuilder(
        title="My Simulation Report",
        subtitle="Monte Carlo analysis — 1000 repetitions",
    )

    report.add_text_section("Purpose", "This model tests...")
    report.add_table_section("Key Metrics", headers=["Metric", "Value"], rows=[...])
    report.add_plot_section("AR Ratio", "/path/to/plot.png")
    report.add_tabbed_section("Scenarios", tabs={
        "Baseline": "<p>Content...</p>",
        "Stress":   "<p>Content...</p>",
    })
    report.add_card_row([
        {"value": "18", "label": "Collapse", "color": "#DC2626"},
        {"value": "9",  "label": "Stressed", "color": "#F59E0B"},
    ])
    report.add_callout("Key finding: ...", style="danger")

    report.save("/path/to/output/report.html")
"""

import base64
import os
import glob
from typing import List, Dict, Optional, Tuple, Any


def _img_to_base64(path: str) -> str:
    """Read a PNG/JPG file and return a base64 data-URI string."""
    if not os.path.exists(path):
        return ""
    ext = os.path.splitext(path)[1].lower()
    mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
            "svg": "image/svg+xml"}.get(ext.lstrip("."), "image/png")
    with open(path, "rb") as f:
        encoded = base64.b64encode(f.read()).decode("utf-8")
    return f"data:{mime};base64,{encoded}"


# ── Shared CSS & JS ──────────────────────────────────────────────────

_CSS = """
:root {
  --bg: #0F172A; --surface: #1E293B; --border: #334155;
  --text: #E2E8F0; --muted: #94A3B8; --accent: #3B82F6;
  --danger: #DC2626; --warn: #F59E0B; --safe: #16A34A;
}
* { margin:0; padding:0; box-sizing:border-box; }
body {
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  background: var(--bg); color: var(--text); line-height: 1.6;
}
.container { max-width: 1100px; margin: 0 auto; padding: 2rem; }
h1 { font-size: 2rem; margin-bottom: 0.25rem; }
h2 { font-size: 1.4rem; margin: 2rem 0 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
h3 { font-size: 1.1rem; margin: 1.5rem 0 0.75rem; color: var(--accent); }
p, li { color: var(--text); margin-bottom: 0.5rem; }
blockquote {
  border-left: 3px solid var(--accent); padding: 0.75rem 1rem;
  background: var(--surface); margin: 1rem 0; border-radius: 0 6px 6px 0;
  font-style: italic; color: var(--muted);
}
code { background: var(--surface); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
table {
  width: 100%; border-collapse: collapse; margin: 1rem 0;
  background: var(--surface); border-radius: 8px; overflow: hidden;
}
th { background: #253348; text-align: left; padding: 10px 14px; font-size: 0.85em;
     text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
td { padding: 10px 14px; border-top: 1px solid var(--border); font-size: 0.92em; }
tr:hover td { background: rgba(59,130,246,0.06); }
.subtitle { color: var(--muted); font-size: 1rem; margin-bottom: 2rem; }
.callout {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0;
}
.callout.warn { border-color: var(--warn); }
.callout.danger { border-color: var(--danger); }
.callout.info { border-color: var(--accent); }
.card-row {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 1rem; margin: 1rem 0;
}
.card {
  background: var(--surface); border-radius: 10px; padding: 1.25rem;
  text-align: center; border: 1px solid var(--border);
}
.card .num { font-size: 2rem; font-weight: 700; }
.card .label { color: var(--muted); font-size: 0.85em; margin-top: 4px; }
img.plot {
  width: 100%; border-radius: 8px; margin: 0.75rem 0;
  border: 1px solid var(--border);
}
.tab-container { margin: 1.5rem 0; }
.tab-buttons { display: flex; gap: 0; border-bottom: 2px solid var(--border); flex-wrap: wrap; }
.tab-btn {
  padding: 10px 20px; cursor: pointer; background: none; border: none;
  color: var(--muted); font-size: 0.9em; font-weight: 600;
  border-bottom: 2px solid transparent; margin-bottom: -2px; transition: all 0.2s;
}
.tab-btn:hover { color: var(--text); }
.tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }
.tab-panel { display: none; padding: 1.5rem 0; }
.tab-panel.active { display: block; }
.plot-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.badge {
  display: inline-block; padding: 2px 10px; border-radius: 12px;
  font-size: 0.85em; font-weight: 600; color: #fff;
}
@media (max-width: 768px) {
  .plot-grid { grid-template-columns: 1fr; }
  .card-row { grid-template-columns: 1fr; }
}
footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--border);
         color: var(--muted); font-size: 0.85em; }
"""

_JS = """
function openTab(evt, tabId) {
  var container = evt.target.closest('.tab-container');
  container.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
  container.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
  container.querySelector('#' + tabId).classList.add('active');
  evt.target.classList.add('active');
}
"""


class ReportBuilder:
    """
    Fluent builder for generating self-contained HTML reports.

    Example::

        report = ReportBuilder("My Report", "Optional subtitle")
        report.add_text_section("Intro", "<p>Hello world</p>")
        report.add_table_section("Results", ["Col A", "Col B"], [["1", "2"]])
        report.save("output/report.html")
    """

    def __init__(self, title: str, subtitle: str = "", footer_text: str = ""):
        self.title = title
        self.subtitle = subtitle
        self.footer_text = footer_text
        self._sections: List[str] = []
        self._tab_counter = 0

    # ── Primitive builders ───────────────────────────────────────────

    def add_raw_html(self, html: str) -> "ReportBuilder":
        """Append raw HTML to the report body."""
        self._sections.append(html)
        return self

    def add_heading(self, text: str, level: int = 2) -> "ReportBuilder":
        """Add a heading (h2 by default)."""
        self._sections.append(f"<h{level}>{text}</h{level}>")
        return self

    def add_text_section(self, title: str, body_html: str) -> "ReportBuilder":
        """Add a titled section with arbitrary HTML body."""
        self._sections.append(f"<h2>{title}</h2>\n{body_html}")
        return self

    def add_blockquote(self, text: str) -> "ReportBuilder":
        """Add a styled blockquote."""
        self._sections.append(f"<blockquote>{text}</blockquote>")
        return self

    def add_callout(self, html: str, style: str = "info") -> "ReportBuilder":
        """Add a callout box. Style: 'info', 'warn', or 'danger'."""
        self._sections.append(f'<div class="callout {style}">{html}</div>')
        return self

    def add_divider(self) -> "ReportBuilder":
        self._sections.append("<hr style='border:none;border-top:1px solid var(--border);margin:2rem 0;'>")
        return self

    # ── Table ────────────────────────────────────────────────────────

    def add_table_section(
        self,
        title: str,
        headers: List[str],
        rows: List[List[str]],
    ) -> "ReportBuilder":
        """Add a titled section containing a table."""
        html = f"<h2>{title}</h2>\n"
        html += self._build_table(headers, rows)
        self._sections.append(html)
        return self

    def add_table(self, headers: List[str], rows: List[List[str]]) -> "ReportBuilder":
        """Add a table without a heading."""
        self._sections.append(self._build_table(headers, rows))
        return self

    @staticmethod
    def _build_table(headers: List[str], rows: List[List[str]]) -> str:
        html = "<table><thead><tr>"
        for h in headers:
            html += f"<th>{h}</th>"
        html += "</tr></thead><tbody>"
        for row in rows:
            html += "<tr>"
            for cell in row:
                html += f"<td>{cell}</td>"
            html += "</tr>"
        html += "</tbody></table>"
        return html

    # ── Cards ────────────────────────────────────────────────────────

    def add_card_row(self, cards: List[Dict[str, str]]) -> "ReportBuilder":
        """
        Add a row of summary cards.

        Each card dict: {"value": "18", "label": "Collapse", "color": "#DC2626"}
        """
        html = '<div class="card-row">'
        for card in cards:
            color = card.get("color", "var(--accent)")
            html += (
                f'<div class="card">'
                f'<div class="num" style="color:{color}">{card["value"]}</div>'
                f'<div class="label">{card["label"]}</div></div>'
            )
        html += "</div>"
        self._sections.append(html)
        return self

    # ── Plots ────────────────────────────────────────────────────────

    def add_plot(self, path: str, caption: str = "") -> "ReportBuilder":
        """Embed a single plot image (base64-encoded)."""
        b64 = _img_to_base64(path)
        if not b64:
            self._sections.append(f"<p><em>Plot not found: {path}</em></p>")
            return self
        cap = f'<p style="text-align:center;color:var(--muted);font-size:0.85em;">{caption}</p>' if caption else ""
        self._sections.append(f'<img class="plot" src="{b64}" alt="{caption}">{cap}')
        return self

    def add_plot_grid(self, paths: List[str], captions: Optional[List[str]] = None) -> "ReportBuilder":
        """Embed multiple plots in a responsive 2-column grid."""
        if captions is None:
            captions = [""] * len(paths)
        html = '<div class="plot-grid">'
        for path, cap in zip(paths, captions):
            b64 = _img_to_base64(path)
            if b64:
                cap_html = f'<p style="text-align:center;color:var(--muted);font-size:0.85em;">{cap}</p>' if cap else ""
                html += f'<div><img class="plot" src="{b64}" alt="{cap}">{cap_html}</div>'
        html += "</div>"
        self._sections.append(html)
        return self

    def add_plot_dir(self, directory: str, title: str = "") -> "ReportBuilder":
        """Embed all PNGs from a directory as a 2-column grid."""
        if title:
            self._sections.append(f"<h3>{title}</h3>")
        pngs = sorted(glob.glob(os.path.join(directory, "*.png")))
        captions = [os.path.splitext(os.path.basename(p))[0].replace("_", " ").title() for p in pngs]
        return self.add_plot_grid(pngs, captions)

    # ── Tabs ─────────────────────────────────────────────────────────

    def add_tabbed_section(self, title: str, tabs: Dict[str, str]) -> "ReportBuilder":
        """
        Add a tabbed section. tabs is {tab_label: inner_html}.
        First tab is active by default.
        """
        self._tab_counter += 1
        prefix = f"tab{self._tab_counter}"

        html = f"<h2>{title}</h2>\n"
        html += '<div class="tab-container"><div class="tab-buttons">'
        for i, label in enumerate(tabs.keys()):
            active = " active" if i == 0 else ""
            tid = f"{prefix}_{i}"
            html += f'<button class="tab-btn{active}" onclick="openTab(event, \'{tid}\')">{label}</button>'
        html += "</div>"

        for i, (label, content) in enumerate(tabs.items()):
            active = " active" if i == 0 else ""
            tid = f"{prefix}_{i}"
            html += f'<div id="{tid}" class="tab-panel{active}">{content}</div>'
        html += "</div>"
        self._sections.append(html)
        return self

    # ── Badge helper ─────────────────────────────────────────────────

    @staticmethod
    def badge(text: str, color: str = "#3B82F6") -> str:
        """Return an inline HTML badge span."""
        return f'<span class="badge" style="background:{color}">{text}</span>'

    # ── Build & Save ─────────────────────────────────────────────────

    def build(self) -> str:
        """Return the complete HTML string."""
        body = "\n".join(self._sections)
        footer = f"<footer><p>{self.footer_text}</p></footer>" if self.footer_text else ""
        sub = f'<p class="subtitle">{self.subtitle}</p>' if self.subtitle else ""

        return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{self.title}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>{_CSS}</style>
</head>
<body>
<div class="container">
<h1>{self.title}</h1>
{sub}
{body}
{footer}
</div>
<script>{_JS}</script>
</body>
</html>"""

    def save(self, path: str) -> str:
        """Write the report to an HTML file. Returns the path."""
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(self.build())
        return path
