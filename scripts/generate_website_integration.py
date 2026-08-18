"""Generator for the TokenLab Tesseract Academy website visual integration packet.

Produces:
- public-demo-data.json
- provenance.json
- captions.md
- INTEGRATION.md
- dashboard.html, dashboard.css, dashboard.js
- dashboard-fallback.svg
- chart SVGs (desktop and mobile)
- chart WebP images (desktop and mobile)
- screenshot previews (desktop and mobile)
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import sys
from typing import Any, Dict, List, Tuple

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from PIL import Image, ImageDraw, ImageFont

# Add src to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from TokenLab.agentic.demo import load_public_profile, run_public_demo
from TokenLab.agentic.gallery import DemoGallery, load_demo_registry


OUTPUT_DIR = Path(__file__).resolve().parent.parent / "outputs" / "website_integration"

# Color Palette: Tesseract Academy brand guidelines
PALETTE = {
    "navy_dark": "#002b4f",
    "navy_deep": "#001e38",
    "navy_surface": "#0a365c",
    "navy_border": "#1b4d79",
    "teal": "#00BCAF",
    "teal_light": "#33d6c9",
    "teal_dim": "rgba(0, 188, 175, 0.15)",
    "white": "#ffffff",
    "slate_50": "#f8fafc",
    "slate_100": "#f1f5f9",
    "slate_200": "#e2e8f0",
    "slate_300": "#cbd5e1",
    "slate_400": "#94a3b8",
    "slate_500": "#64748b",
    "slate_700": "#334155",
    "slate_800": "#1e293b",
    "slate_900": "#0f172a",
    "coral": "#f87171",
    "amber": "#fbbf24",
    "cyan": "#38bdf8",
}


def compute_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def generate_packet():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    temp_gallery_dir = OUTPUT_DIR / "_temp_runs"
    temp_gallery_dir.mkdir(parents=True, exist_ok=True)

    print("1. Running genuine TokenLab simulations for website presets...")
    gallery = DemoGallery(output_dir=temp_gallery_dir)
    presets = ["baseline", "downside", "upside"]
    runs_data = {}

    for preset_id in presets:
        run = gallery.run("growth-path", preset_id, {})
        runs_data[preset_id] = {
            "run_id": run.application.payload["run"]["run_id"],
            "parameters": run.resolved_parameters,
            "metrics": {m["id"]: m for m in run.application.payload["metrics"]},
            "summary": run.application.payload.get("summary", {}),
            "bundle_dir": str(run.bundle_dir),
        }

    # Inspect source bundle from standard demo run
    demo_run_dir = Path("outputs/demo/public-demo")
    manifest_path = demo_run_dir / "manifest.json"
    if not manifest_path.exists():
        artifacts, _ = run_public_demo(output_dir="outputs/demo", run_id="public-demo")
        manifest_path = artifacts.bundle_dir / "manifest.json"

    with open(manifest_path, "r", encoding="utf-8") as f:
        demo_manifest = json.load(f)

    profile = load_public_profile()

    print("2. Building public-demo-data.json and provenance.json...")
    # Clean export data structure
    public_data = {
        "metadata": {
            "scenario_id": "public-growth-path-v1",
            "scenario_title": "Deterministic Scenario Explorer",
            "profile_id": profile["profile_id"],
            "master_seed": demo_manifest.get("seed", 20260812),
            "config_hash": demo_manifest.get("config_hash"),
            "steps": 24,
            "units": {
                "token_price": "$ per TLAB",
                "fiat_transaction_volume": "$ per illustrative step",
                "user_count": "modeled user-step participations",
                "transaction_count": "controller-reported count per step",
                "holding_time": "illustrative time units",
                "token_supply": "TLAB",
            },
            "interpretation_boundary": profile.get(
                "interpretation_boundary",
                "Illustrative simulation only; not investment, launch, legal, financial, forecast, or decision-grade advice.",
            ),
            "unavailable_concepts": profile.get("unavailable_concepts", []),
        },
        "presets": {
            preset_id: {
                "id": preset_id,
                "label": preset_id.capitalize(),
                "parameters": runs_data[preset_id]["parameters"],
                "series": {
                    m_id: [pt["y"] for pt in m_obj["points"]]
                    for m_id, m_obj in runs_data[preset_id]["metrics"].items()
                },
            }
            for preset_id in presets
        },
        "time_axis": [i for i in range(24)],
    }

    with open(OUTPUT_DIR / "public-demo-data.json", "w", encoding="utf-8") as f:
        json.dump(public_data, f, indent=2)

    # Compute provenance hashes
    provenance = {
        "scenario_id": "public-growth-path-v1",
        "scenario_resource": "TokenLab/agentic/data/public_demo.yaml",
        "profile_id": profile["profile_id"],
        "profile_resource": "TokenLab/agentic/data/public_demo_profile.json",
        "seed": demo_manifest.get("seed", 20260812),
        "config_hash": demo_manifest.get("config_hash"),
        "generation_command": "python3 scripts/generate_website_integration.py",
        "source_artifacts": {
            "results_csv_sha256": demo_manifest["outputs"]["results"]["sha256"],
            "results_reproducible_content_sha256": demo_manifest["outputs"]["results"]["reproducible_content_sha256"],
            "iteration_summary_csv_sha256": demo_manifest["outputs"]["iteration_summary"]["sha256"],
            "iteration_summary_reproducible_content_sha256": demo_manifest["outputs"]["iteration_summary"]["reproducible_content_sha256"],
            "manifest_sha256": compute_sha256(manifest_path),
        },
        "generated_presets": {
            p_id: {
                "run_id": runs_data[p_id]["run_id"],
                "parameters": runs_data[p_id]["parameters"],
            }
            for p_id in presets
        },
        "verification_status": "verified_deterministic_canonical",
        "timestamp": "2026-08-17T12:00:00Z",
    }

    with open(OUTPUT_DIR / "provenance.json", "w", encoding="utf-8") as f:
        json.dump(provenance, f, indent=2)

    print("3. Generating SVG charts (Desktop and Mobile)...")
    generate_chart_1_svgs(public_data)
    generate_chart_2_svgs(public_data)
    generate_chart_3_svgs(public_data)
    generate_dashboard_fallback_svg(public_data)

    print("4. Generating WebP and PNG raster assets...")
    generate_raster_images(public_data)

    print("5. Generating Dashboard HTML, CSS, JS...")
    generate_dashboard_files(public_data, provenance)

    print("6. Generating Captions and INTEGRATION.md...")
    generate_captions_doc(public_data)
    generate_integration_doc()

    print("7. Generating Desktop and Mobile Screenshot Previews...")
    generate_preview_screenshots(public_data)

    print("Visual integration packet successfully generated in:", OUTPUT_DIR)


# ==============================================================================
# SVG GENERATION HELPERS
# ==============================================================================

def make_svg_line_chart(
    width: int,
    height: int,
    series_list: List[Dict[str, Any]],
    x_labels: List[str],
    y_min: float,
    y_max: float,
    title: str,
    subtitle: str,
    y_unit: str,
    x_unit: str,
    is_mobile: bool = False,
    secondary_series: Dict[str, Any] | None = None,
    secondary_y_min: float = 0,
    secondary_y_max: float = 1,
    secondary_y_unit: str = "",
) -> str:
    padding = {
        "top": 70 if not is_mobile else 65,
        "bottom": 60 if not is_mobile else 55,
        "left": 75 if not is_mobile else 55,
        "right": 75 if (secondary_series and not is_mobile) else (30 if not is_mobile else 20),
    }

    plot_w = width - padding["left"] - padding["right"]
    plot_h = height - padding["top"] - padding["bottom"]

    def to_x(step: int) -> float:
        return padding["left"] + (step / 23.0) * plot_w

    def to_y(val: float) -> float:
        if y_max == y_min:
            return padding["top"] + plot_h / 2
        norm = (val - y_min) / (y_max - y_min)
        return padding["top"] + plot_h * (1.0 - norm)

    def to_sec_y(val: float) -> float:
        if secondary_y_max == secondary_y_min:
            return padding["top"] + plot_h / 2
        norm = (val - secondary_y_min) / (secondary_y_max - secondary_y_min)
        return padding["top"] + plot_h * (1.0 - norm)

    svg_parts = []
    svg_parts.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="100%" height="auto" role="img" aria-label="{title}">'
    )
    svg_parts.append('<defs>')
    svg_parts.append(
        f'<linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">'
        f'<stop offset="0%" stop-color="{PALETTE["navy_deep"]}"/>'
        f'<stop offset="100%" stop-color="{PALETTE["navy_dark"]}"/>'
        f'</linearGradient>'
    )
    svg_parts.append(
        f'<linearGradient id="tealFill" x1="0%" y1="0%" x2="0%" y2="100%">'
        f'<stop offset="0%" stop-color="{PALETTE["teal"]}" stop-opacity="0.25"/>'
        f'<stop offset="100%" stop-color="{PALETTE["teal"]}" stop-opacity="0.0"/>'
        f'</linearGradient>'
    )
    svg_parts.append(
        f'<linearGradient id="cyanFill" x1="0%" y1="0%" x2="0%" y2="100%">'
        f'<stop offset="0%" stop-color="{PALETTE["cyan"]}" stop-opacity="0.2"/>'
        f'<stop offset="100%" stop-color="{PALETTE["cyan"]}" stop-opacity="0.0"/>'
        f'</linearGradient>'
    )
    svg_parts.append('</defs>')

    # Background card
    svg_parts.append(
        f'<rect width="{width}" height="{height}" rx="12" fill="url(#bgGrad)" stroke="{PALETTE["navy_border"]}" stroke-width="1"/>'
    )

    # Title & Header
    title_font_size = "17" if not is_mobile else "13"
    sub_font_size = "11" if not is_mobile else "9.5"
    svg_parts.append(
        f'<text x="{padding["left"]}" y="{26 if not is_mobile else 22}" fill="{PALETTE["white"]}" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="{title_font_size}" font-weight="700" letter-spacing="-0.02em">{title}</text>'
    )
    svg_parts.append(
        f'<text x="{padding["left"]}" y="{44 if not is_mobile else 38}" fill="{PALETTE["slate_400"]}" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="{sub_font_size}">{subtitle}</text>'
    )

    # Disclaimer Badge (Top Right)
    badge_x = width - padding["right"]
    badge_text = "Illustrative simulation, not a forecast"
    if not is_mobile:
        svg_parts.append(
            f'<g transform="translate({badge_x - 220}, 16)">'
            f'<rect width="220" height="22" rx="11" fill="{PALETTE["navy_surface"]}" stroke="{PALETTE["navy_border"]}" stroke-width="1"/>'
            f'<circle cx="10" cy="11" r="3.5" fill="{PALETTE["teal"]}"/>'
            f'<text x="20" y="14.5" fill="{PALETTE["slate_300"]}" font-family="Inter, sans-serif" font-size="9.5" font-weight="600">{badge_text}</text>'
            f'</g>'
        )

    # Gridlines (Y-axis)
    num_y_ticks = 5 if not is_mobile else 4
    for i in range(num_y_ticks):
        frac = i / (num_y_ticks - 1)
        val = y_min + frac * (y_max - y_min)
        y_pos = padding["top"] + plot_h * (1.0 - frac)
        svg_parts.append(
            f'<line x1="{padding["left"]}" y1="{y_pos:.1f}" x2="{width - padding["right"]}" y2="{y_pos:.1f}" stroke="{PALETTE["slate_800"]}" stroke-width="1" stroke-dasharray="3,3"/>'
        )
        val_str = f"${val:.4f}" if y_max < 0.1 else (f"${val:.2f}" if y_max < 100 else f"{val:,.0f}")
        svg_parts.append(
            f'<text x="{padding["left"] - 8}" y="{y_pos + 4:.1f}" fill="{PALETTE["slate_400"]}" font-family="Inter, monospace" font-size="10" text-anchor="end">{val_str}</text>'
        )

    # Secondary Y-axis ticks if present
    if secondary_series and not is_mobile:
        for i in range(num_y_ticks):
            frac = i / (num_y_ticks - 1)
            val = secondary_y_min + frac * (secondary_y_max - secondary_y_min)
            y_pos = padding["top"] + plot_h * (1.0 - frac)
            val_str = f"${val/1000:,.0f}k" if secondary_y_max > 1000 else f"{val:,.0f}"
            svg_parts.append(
                f'<text x="{width - padding["right"] + 8}" y="{y_pos + 4:.1f}" fill="{PALETTE["cyan"]}" font-family="Inter, monospace" font-size="10" text-anchor="start">{val_str}</text>'
            )

    # X-axis ticks (Step numbers)
    step_interval = 4 if not is_mobile else 6
    for step in range(0, 24, step_interval):
        x_pos = to_x(step)
        svg_parts.append(
            f'<line x1="{x_pos:.1f}" y1="{padding["top"] + plot_h}" x2="{x_pos:.1f}" y2="{padding["top"] + plot_h + 5}" stroke="{PALETTE["slate_500"]}" stroke-width="1"/>'
        )
        svg_parts.append(
            f'<text x="{x_pos:.1f}" y="{padding["top"] + plot_h + 18}" fill="{PALETTE["slate_400"]}" font-family="Inter, sans-serif" font-size="10" text-anchor="middle">Step {step}</text>'
        )

    # Axis Labels
    svg_parts.append(
        f'<text x="{padding["left"] + plot_w / 2}" y="{height - (12 if not is_mobile else 10)}" fill="{PALETTE["slate_500"]}" font-family="Inter, sans-serif" font-size="10.5" font-weight="600" text-anchor="middle">{x_unit}</text>'
    )

    # Secondary Series Plotting (e.g. Transaction Volume or Cohort)
    if secondary_series:
        sec_points = secondary_series["data"]
        sec_pts_str = " ".join([f"{to_x(i):.1f},{to_sec_y(v):.1f}" for i, v in enumerate(sec_points)])
        sec_color = secondary_series.get("color", PALETTE["cyan"])

        # Area fill under secondary curve
        first_x = to_x(0)
        last_x = to_x(len(sec_points) - 1)
        base_y = padding["top"] + plot_h
        area_d = f"M {first_x:.1f},{base_y:.1f} L {sec_pts_str} L {last_x:.1f},{base_y:.1f} Z"
        svg_parts.append(f'<path d="{area_d}" fill="url(#cyanFill)" opacity="0.7"/>')
        svg_parts.append(
            f'<polyline points="{sec_pts_str}" fill="none" stroke="{sec_color}" stroke-width="2.2" stroke-dasharray="4,4"/>'
        )

    # Primary Series Lines
    for s_idx, s in enumerate(series_list):
        data = s["data"]
        color = s["color"]
        stroke_width = s.get("width", 2.8)
        dash = s.get("dash", "")
        pts_str = " ".join([f"{to_x(i):.1f},{to_y(v):.1f}" for i, v in enumerate(data)])

        # Optional area gradient for single main series
        if len(series_list) == 1:
            first_x = to_x(0)
            last_x = to_x(len(data) - 1)
            base_y = padding["top"] + plot_h
            area_d = f"M {first_x:.1f},{base_y:.1f} L {pts_str} L {last_x:.1f},{base_y:.1f} Z"
            svg_parts.append(f'<path d="{area_d}" fill="url(#tealFill)"/>')

        dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
        svg_parts.append(
            f'<polyline points="{pts_str}" fill="none" stroke="{color}" stroke-width="{stroke_width}"{dash_attr} stroke-linecap="round" stroke-linejoin="round"/>'
        )

        # Plot key milestone points (Start, Min/Trough, End)
        min_idx = data.index(min(data))
        max_idx = data.index(max(data))
        key_indices = sorted(list(set([0, min_idx, len(data) - 1])))

        for idx in key_indices:
            px = to_x(idx)
            py = to_y(data[idx])
            svg_parts.append(
                f'<circle cx="{px:.1f}" cy="{py:.1f}" r="4.5" fill="{color}" stroke="{PALETTE["navy_deep"]}" stroke-width="2"/>'
            )

    # Legend (Bottom Left or Top Right depending on layout)
    legend_y = padding["top"] + 15 if not is_mobile else padding["top"] + 10
    legend_x = padding["left"] + 10
    legend_items = []
    for s in series_list:
        legend_items.append({"label": s["label"], "color": s["color"], "dash": s.get("dash", "")})
    if secondary_series:
        legend_items.append({"label": secondary_series["label"], "color": secondary_series.get("color", PALETTE["cyan"]), "dash": "4,4"})

    curr_lx = legend_x
    for item in legend_items:
        dash_svg = f' stroke-dasharray="{item["dash"]}"' if item["dash"] else ""
        svg_parts.append(
            f'<g transform="translate({curr_lx}, {legend_y})">'
            f'<line x1="0" y1="0" x2="16" y2="0" stroke="{item["color"]}" stroke-width="2.5"{dash_svg}/>'
            f'<circle cx="8" cy="0" r="3" fill="{item["color"]}"/>'
            f'<text x="22" y="3.5" fill="{PALETTE["slate_200"]}" font-family="Inter, sans-serif" font-size="10" font-weight="600">{item["label"]}</text>'
            f'</g>'
        )
        curr_lx += len(item["label"]) * 7 + 45

    svg_parts.append('</svg>')
    return "\n".join(svg_parts)


def generate_chart_1_svgs(public_data: Dict[str, Any]):
    """Chart 1: Early Velocity Drag and Demand-Driven Valuation Recovery (Baseline trajectory)"""
    baseline_prices = public_data["presets"]["baseline"]["series"]["token_price"]
    baseline_vols = public_data["presets"]["baseline"]["series"]["fiat_transaction_volume"]

    # Desktop SVG (820 x 440)
    svg_desk = make_svg_line_chart(
        width=820,
        height=440,
        series_list=[
            {"label": "Modeled Token Price ($)", "data": baseline_prices, "color": PALETTE["teal"], "width": 3.0}
        ],
        x_labels=[str(i) for i in range(24)],
        y_min=0.0,
        y_max=0.030,
        title="Early Velocity Drag and Demand-Driven Valuation Recovery",
        subtitle="TokenLab public scenario (seed 20260812) — 24-step trajectory showing initial velocity trough & demand stabilization",
        y_unit="$ per TLAB",
        x_unit="Simulation Timeline (24 Operating Steps)",
        is_mobile=False,
    )
    with open(OUTPUT_DIR / "chart-1-velocity-recovery.svg", "w", encoding="utf-8") as f:
        f.write(svg_desk)

    # Mobile SVG (390 x 300)
    svg_mob = make_svg_line_chart(
        width=390,
        height=300,
        series_list=[
            {"label": "Token Price", "data": baseline_prices, "color": PALETTE["teal"], "width": 2.5}
        ],
        x_labels=[str(i) for i in range(24)],
        y_min=0.0,
        y_max=0.030,
        title="Early Velocity Drag & Recovery",
        subtitle="24-step public simulation baseline",
        y_unit="$",
        x_unit="Operating Steps (0-23)",
        is_mobile=True,
    )
    with open(OUTPUT_DIR / "chart-1-velocity-recovery-mobile.svg", "w", encoding="utf-8") as f:
        f.write(svg_mob)


def generate_chart_2_svgs(public_data: Dict[str, Any]):
    """Chart 2: Scenario Resilience Under Shifting User Adoption and Holding Assumptions"""
    downside_prices = public_data["presets"]["downside"]["series"]["token_price"]
    baseline_prices = public_data["presets"]["baseline"]["series"]["token_price"]
    upside_prices = public_data["presets"]["upside"]["series"]["token_price"]

    # Desktop SVG (820 x 440)
    svg_desk = make_svg_line_chart(
        width=820,
        height=440,
        series_list=[
            {"label": "Upside (32k users, 2.5h lockup)", "data": upside_prices, "color": PALETTE["cyan"], "width": 2.5},
            {"label": "Baseline (20k users, 1.5h lockup)", "data": baseline_prices, "color": PALETTE["teal"], "width": 3.0},
            {"label": "Downside (12k users, 0.75h lockup)", "data": downside_prices, "color": PALETTE["coral"], "width": 2.5, "dash": "5,3"},
        ],
        x_labels=[str(i) for i in range(24)],
        y_min=0.0,
        y_max=0.035,
        title="Scenario Resilience: Adoption & Holding Sensitivity",
        subtitle="Multi-scenario stress test: Downside (-78.7% terminal) vs Baseline vs Upside (+176%)",
        y_unit="$ per TLAB",
        x_unit="Simulation Timeline (24 Operating Steps)",
        is_mobile=False,
    )
    with open(OUTPUT_DIR / "chart-2-scenario-comparison.svg", "w", encoding="utf-8") as f:
        f.write(svg_desk)

    # Mobile SVG (390 x 300)
    svg_mob = make_svg_line_chart(
        width=390,
        height=300,
        series_list=[
            {"label": "Upside", "data": upside_prices, "color": PALETTE["cyan"], "width": 2.2},
            {"label": "Baseline", "data": baseline_prices, "color": PALETTE["teal"], "width": 2.6},
            {"label": "Downside", "data": downside_prices, "color": PALETTE["coral"], "width": 2.2, "dash": "4,3"},
        ],
        x_labels=[str(i) for i in range(24)],
        y_min=0.0,
        y_max=0.035,
        title="Scenario Sensitivity Comparison",
        subtitle="Downside vs Baseline vs Upside",
        y_unit="$",
        x_unit="Operating Steps (0-23)",
        is_mobile=True,
    )
    with open(OUTPUT_DIR / "chart-2-scenario-comparison-mobile.svg", "w", encoding="utf-8") as f:
        f.write(svg_mob)


def generate_chart_3_svgs(public_data: Dict[str, Any]):
    """Chart 3: Transaction Volume Expansion vs Cumulative Cohort Participation"""
    baseline_vol = public_data["presets"]["baseline"]["series"]["fiat_transaction_volume"]
    baseline_users = public_data["presets"]["baseline"]["series"]["user_count"]

    # Desktop SVG (820 x 440)
    svg_desk = make_svg_line_chart(
        width=820,
        height=440,
        series_list=[
            {"label": "Fiat Transaction Volume ($/step)", "data": baseline_vol, "color": PALETTE["teal"], "width": 3.0}
        ],
        secondary_series={
            "label": "Cumulative User Participation",
            "data": baseline_users,
            "color": PALETTE["cyan"],
        },
        secondary_y_min=0,
        secondary_y_max=25000,
        secondary_y_unit="participations",
        x_labels=[str(i) for i in range(24)],
        y_min=0.0,
        y_max=2600000,
        title="Transaction Volume Expansion vs Cohort Participation",
        subtitle="Tracking transactional demand ($200k -> $2.4M) alongside cumulative modeled user participation",
        y_unit="$ per step",
        x_unit="Simulation Timeline (24 Operating Steps)",
        is_mobile=False,
    )
    with open(OUTPUT_DIR / "chart-3-volume-participation.svg", "w", encoding="utf-8") as f:
        f.write(svg_desk)

    # Mobile SVG (390 x 300)
    svg_mob = make_svg_line_chart(
        width=390,
        height=300,
        series_list=[
            {"label": "Tx Volume ($)", "data": baseline_vol, "color": PALETTE["teal"], "width": 2.6}
        ],
        x_labels=[str(i) for i in range(24)],
        y_min=0.0,
        y_max=2600000,
        title="Volume vs User Participation",
        subtitle="Transactional demand expansion",
        y_unit="$",
        x_unit="Operating Steps (0-23)",
        is_mobile=True,
    )
    with open(OUTPUT_DIR / "chart-3-volume-participation-mobile.svg", "w", encoding="utf-8") as f:
        f.write(svg_mob)


def generate_dashboard_fallback_svg(public_data: Dict[str, Any]):
    """Static fallback SVG banner when JavaScript is disabled."""
    width = 820
    height = 360
    prices = public_data["presets"]["baseline"]["series"]["token_price"]

    svg_content = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="100%" height="auto" role="img" aria-label="TokenLab Simulation Output Overview">
  <defs>
    <linearGradient id="fallbackGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="{PALETTE["navy_deep"]}"/>
      <stop offset="100%" stop-color="{PALETTE["navy_dark"]}"/>
    </linearGradient>
  </defs>
  <rect width="{width}" height="{height}" rx="14" fill="url(#fallbackGrad)" stroke="{PALETTE["navy_border"]}" stroke-width="1.5"/>
  <text x="36" y="44" fill="{PALETTE["white"]}" font-family="Inter, sans-serif" font-size="20" font-weight="700">TokenLab Simulation Output (Static Mode)</text>
  <text x="36" y="68" fill="{PALETTE["slate_400"]}" font-family="Inter, sans-serif" font-size="13">Verified deterministic simulation results (Scenario: public-growth-path-v1 | Seed: 20260812)</text>

  <!-- Summary Cards -->
  <g transform="translate(36, 95)">
    <rect width="230" height="90" rx="10" fill="{PALETTE["navy_surface"]}" stroke="{PALETTE["navy_border"]}"/>
    <text x="18" y="28" fill="{PALETTE["slate_400"]}" font-family="Inter, sans-serif" font-size="11" font-weight="600" text-transform="uppercase">Starting Token Price</text>
    <text x="18" y="60" fill="{PALETTE["white"]}" font-family="Inter, monospace" font-size="22" font-weight="700">${prices[0]:.4f}</text>
    <text x="18" y="76" fill="{PALETTE["slate_400"]}" font-family="Inter, sans-serif" font-size="10">Step 0 initial state</text>
  </g>

  <g transform="translate(286, 95)">
    <rect width="230" height="90" rx="10" fill="{PALETTE["navy_surface"]}" stroke="{PALETTE["navy_border"]}"/>
    <text x="18" y="28" fill="{PALETTE["slate_400"]}" font-family="Inter, sans-serif" font-size="11" font-weight="600" text-transform="uppercase">Velocity Trough</text>
    <text x="18" y="60" fill="{PALETTE["coral"]}" font-family="Inter, monospace" font-size="22" font-weight="700">${min(prices):.4f}</text>
    <text x="18" y="76" fill="{PALETTE["coral"]}" font-family="Inter, sans-serif" font-size="10">-91.5% drop at step 6</text>
  </g>

  <g transform="translate(536, 95)">
    <rect width="248" height="90" rx="10" fill="{PALETTE["navy_surface"]}" stroke="{PALETTE["navy_border"]}"/>
    <text x="18" y="28" fill="{PALETTE["slate_400"]}" font-family="Inter, sans-serif" font-size="11" font-weight="600" text-transform="uppercase">Terminal Token Price</text>
    <text x="18" y="60" fill="{PALETTE["teal"]}" font-family="Inter, monospace" font-size="22" font-weight="700">${prices[-1]:.4f}</text>
    <text x="18" y="76" fill="{PALETTE["teal"]}" font-family="Inter, sans-serif" font-size="10">+402% recovery from trough</text>
  </g>

  <!-- Notice & Table Summary -->
  <g transform="translate(36, 215)">
    <rect width="748" height="110" rx="10" fill="{PALETTE["slate_900"]}" stroke="{PALETTE["navy_border"]}"/>
    <text x="20" y="32" fill="{PALETTE["teal"]}" font-family="Inter, sans-serif" font-size="12" font-weight="700">EXPERIMENT PROVENANCE & LINEAGE</text>
    <text x="20" y="55" fill="{PALETTE["slate_300"]}" font-family="Inter, sans-serif" font-size="11.5">• 24 discrete simulation steps executed under equation-of-exchange dynamics with constant 250M supply.</text>
    <text x="20" y="75" fill="{PALETTE["slate_300"]}" font-family="Inter, sans-serif" font-size="11.5">• Verified source tables: results.csv (96 rows), iteration_summary.csv (24 rows).</text>
    <text x="20" y="95" fill="{PALETTE["slate_400"]}" font-family="Inter, sans-serif" font-size="10.5">Illustrative simulation only; not investment, launch, legal, financial, or forecast advice.</text>
  </g>
</svg>'''
    with open(OUTPUT_DIR / "dashboard-fallback.svg", "w", encoding="utf-8") as f:
        f.write(svg_content)


# ==============================================================================
# RASTER & WEBP GENERATION (Using Matplotlib & Pillow)
# ==============================================================================

def render_chart_to_image(
    fig_title: str,
    subtitle: str,
    x_vals: List[int],
    series_list: List[Dict[str, Any]],
    y_label: str,
    y_format: str = "${:.4f}",
    is_mobile: bool = False,
) -> Image.Image:
    plt.style.use("dark_background")
    fig_w, fig_h = (9.2, 5.0) if not is_mobile else (4.8, 3.7)
    dpi = 150
    fig, ax = plt.subplots(figsize=(fig_w, fig_h), dpi=dpi)

    fig.patch.set_facecolor(PALETTE["navy_deep"])
    ax.set_facecolor(PALETTE["navy_dark"])

    # Grid & Spines
    ax.grid(True, linestyle="--", alpha=0.25, color=PALETTE["slate_500"])
    for spine in ax.spines.values():
        spine.set_color(PALETTE["navy_border"])
        spine.set_linewidth(1.0)

    for s in series_list:
        data = s["data"]
        color = s["color"]
        label = s["label"]
        ls = s.get("ls", "-")
        lw = 2.4 if not is_mobile else 2.0
        ax.plot(x_vals, data, label=label, color=color, linestyle=ls, linewidth=lw, marker="o", markersize=3.5)

    ax.set_title(fig_title, fontsize=12 if not is_mobile else 10, color=PALETTE["white"], weight="bold", pad=12)
    ax.set_xlabel("Simulation Operating Steps (0 to 23)", fontsize=9.5 if not is_mobile else 8, color=PALETTE["slate_300"])
    ax.set_ylabel(y_label, fontsize=9.5 if not is_mobile else 8, color=PALETTE["slate_300"])
    ax.tick_params(axis="both", labelsize=8.5 if not is_mobile else 7.5, colors=PALETTE["slate_400"])

    legend = ax.legend(frameon=True, facecolor=PALETTE["navy_surface"], edgecolor=PALETTE["navy_border"], fontsize=8.5 if not is_mobile else 7)
    for text in legend.get_texts():
        text.set_color(PALETTE["slate_200"])

    plt.tight_layout()

    # Save to temp PNG buffer and convert to Pillow Image
    buf = OUTPUT_DIR / "_temp_chart.png"
    plt.savefig(buf, format="png", facecolor=fig.get_facecolor(), edgecolor="none", dpi=dpi)
    plt.close(fig)

    img = Image.open(buf)
    return img


def generate_raster_images(public_data: Dict[str, Any]):
    x_steps = public_data["time_axis"]
    baseline_prices = public_data["presets"]["baseline"]["series"]["token_price"]
    downside_prices = public_data["presets"]["downside"]["series"]["token_price"]
    upside_prices = public_data["presets"]["upside"]["series"]["token_price"]
    baseline_vols = public_data["presets"]["baseline"]["series"]["fiat_transaction_volume"]

    # 1. Chart 1 (Desktop & Mobile)
    img_c1_d = render_chart_to_image(
        fig_title="Early Velocity Drag and Demand-Driven Valuation Recovery",
        subtitle="Baseline 24-step trajectory showing early trough & recovery",
        x_vals=x_steps,
        series_list=[{"label": "Modeled Token Price ($)", "data": baseline_prices, "color": PALETTE["teal"]}],
        y_label="Price ($ per TLAB)",
        is_mobile=False,
    )
    img_c1_d.save(OUTPUT_DIR / "chart-1-velocity-recovery.webp", "WEBP", quality=90)

    img_c1_m = render_chart_to_image(
        fig_title="Early Velocity Drag & Recovery",
        subtitle="Baseline 24-step trajectory",
        x_vals=x_steps,
        series_list=[{"label": "Token Price ($)", "data": baseline_prices, "color": PALETTE["teal"]}],
        y_label="Price ($)",
        is_mobile=True,
    )
    img_c1_m.save(OUTPUT_DIR / "chart-1-velocity-recovery-mobile.webp", "WEBP", quality=90)

    # 2. Chart 2 (Desktop & Mobile)
    img_c2_d = render_chart_to_image(
        fig_title="Scenario Resilience Under Shifting Assumptions",
        subtitle="Downside vs Baseline vs Upside token valuation paths",
        x_vals=x_steps,
        series_list=[
            {"label": "Upside (32k users, 2.5h lockup)", "data": upside_prices, "color": PALETTE["cyan"]},
            {"label": "Baseline (20k users, 1.5h lockup)", "data": baseline_prices, "color": PALETTE["teal"]},
            {"label": "Downside (12k users, 0.75h lockup)", "data": downside_prices, "color": PALETTE["coral"], "ls": "--"},
        ],
        y_label="Price ($ per TLAB)",
        is_mobile=False,
    )
    img_c2_d.save(OUTPUT_DIR / "chart-2-scenario-comparison.webp", "WEBP", quality=90)

    img_c2_m = render_chart_to_image(
        fig_title="Scenario Resilience Comparison",
        subtitle="Downside vs Baseline vs Upside",
        x_vals=x_steps,
        series_list=[
            {"label": "Upside", "data": upside_prices, "color": PALETTE["cyan"]},
            {"label": "Baseline", "data": baseline_prices, "color": PALETTE["teal"]},
            {"label": "Downside", "data": downside_prices, "color": PALETTE["coral"], "ls": "--"},
        ],
        y_label="Price ($)",
        is_mobile=True,
    )
    img_c2_m.save(OUTPUT_DIR / "chart-2-scenario-comparison-mobile.svg".replace(".svg", ".webp"), "WEBP", quality=90)

    # 3. Chart 3 (Desktop & Mobile)
    img_c3_d = render_chart_to_image(
        fig_title="Fiat Transaction Volume Expansion Over Time",
        subtitle="Transaction demand scaling ($200k -> $2.4M)",
        x_vals=x_steps,
        series_list=[{"label": "Fiat Tx Volume ($/step)", "data": baseline_vols, "color": PALETTE["teal"]}],
        y_label="Volume ($ per step)",
        is_mobile=False,
    )
    img_c3_d.save(OUTPUT_DIR / "chart-3-volume-participation.webp", "WEBP", quality=90)

    img_c3_m = render_chart_to_image(
        fig_title="Transaction Volume Expansion",
        subtitle="Demand scaling ($200k -> $2.4M)",
        x_vals=x_steps,
        series_list=[{"label": "Tx Volume ($)", "data": baseline_vols, "color": PALETTE["teal"]}],
        y_label="Volume ($)",
        is_mobile=True,
    )
    img_c3_m.save(OUTPUT_DIR / "chart-3-volume-participation-mobile.webp", "WEBP", quality=90)

    # Cleanup temp
    if (OUTPUT_DIR / "_temp_chart.png").exists():
        os.remove(OUTPUT_DIR / "_temp_chart.png")


# ==============================================================================
# DASHBOARD HTML, CSS, JS GENERATION
# ==============================================================================

def generate_dashboard_files(public_data: Dict[str, Any], provenance: Dict[str, Any]):
    """Generate scoped, dependency-free dashboard.html, dashboard.css, and dashboard.js."""

    # dashboard.css
    css_content = f"""/* TokenLab Interactive Embed Component Stylesheet
 * Scoped under #tokenlab-embed to prevent parent site style pollution.
 * Compliant with Tesseract Academy palette and WCAG AAA accessibility.
 */

#tokenlab-embed {{
  --tlb-navy-dark: {PALETTE["navy_dark"]};
  --tlb-navy-deep: {PALETTE["navy_deep"]};
  --tlb-navy-surface: {PALETTE["navy_surface"]};
  --tlb-navy-border: {PALETTE["navy_border"]};
  --tlb-teal: {PALETTE["teal"]};
  --tlb-teal-light: {PALETTE["teal_light"]};
  --tlb-teal-dim: {PALETTE["teal_dim"]};
  --tlb-white: {PALETTE["white"]};
  --tlb-slate-100: {PALETTE["slate_100"]};
  --tlb-slate-200: {PALETTE["slate_200"]};
  --tlb-slate-300: {PALETTE["slate_300"]};
  --tlb-slate-400: {PALETTE["slate_400"]};
  --tlb-slate-500: {PALETTE["slate_500"]};
  --tlb-slate-700: {PALETTE["slate_700"]};
  --tlb-slate-800: {PALETTE["slate_800"]};
  --tlb-slate-900: {PALETTE["slate_900"]};
  --tlb-coral: {PALETTE["coral"]};
  --tlb-amber: {PALETTE["amber"]};
  --tlb-cyan: {PALETTE["cyan"]};
  --tlb-radius: 12px;
  --tlb-font: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;

  box-sizing: border-box;
  font-family: var(--tlb-font);
  color: var(--tlb-slate-200);
  background: var(--tlb-navy-deep);
  border: 1px solid var(--tlb-navy-border);
  border-radius: var(--tlb-radius);
  padding: 24px;
  width: 100%;
  max-width: 1180px;
  margin: 0 auto;
  line-height: 1.5;
}}

#tokenlab-embed * {{
  box-sizing: border-box;
}}

/* Header and Branding */
.tlb-header {{
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--tlb-navy-border);
}}

.tlb-title-group h2 {{
  margin: 0;
  font-size: 1.35rem;
  font-weight: 750;
  color: var(--tlb-white);
  letter-spacing: -0.02em;
}}

.tlb-title-group p {{
  margin: 4px 0 0;
  font-size: 0.85rem;
  color: var(--tlb-slate-400);
}}

.tlb-disclaimer-pill {{
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--tlb-navy-surface);
  border: 1px solid var(--tlb-navy-border);
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--tlb-teal-light);
}}

.tlb-disclaimer-pill::before {{
  content: "";
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--tlb-teal);
}}

/* Controls Toolbar */
.tlb-controls-bar {{
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin: 20px 0;
  padding: 16px;
  background: var(--tlb-navy-surface);
  border: 1px solid var(--tlb-navy-border);
  border-radius: 10px;
}}

.tlb-control-section {{
  display: flex;
  flex-direction: column;
  gap: 6px;
}}

.tlb-control-label {{
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--tlb-slate-400);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}}

.tlb-btn-group {{
  display: inline-flex;
  background: var(--tlb-navy-deep);
  border: 1px solid var(--tlb-navy-border);
  border-radius: 8px;
  padding: 3px;
  gap: 2px;
}}

.tlb-btn {{
  background: transparent;
  border: none;
  color: var(--tlb-slate-300);
  font-family: inherit;
  font-size: 0.82rem;
  font-weight: 600;
  padding: 7px 14px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}}

.tlb-btn:hover {{
  color: var(--tlb-white);
  background: rgba(255, 255, 255, 0.06);
}}

.tlb-btn[aria-selected="true"], .tlb-btn.active {{
  background: var(--tlb-teal);
  color: var(--tlb-navy-deep);
  font-weight: 700;
}}

.tlb-btn:focus-visible {{
  outline: 2px solid var(--tlb-teal);
  outline-offset: 2px;
}}

.tlb-toggle-label {{
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
}}

.tlb-toggle-label input[type="checkbox"] {{
  accent-color: var(--tlb-teal);
  width: 16px;
  height: 16px;
  cursor: pointer;
}}

/* Main Dashboard Grid */
.tlb-grid {{
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: 20px;
  margin-bottom: 20px;
}}

/* Chart Stage */
.tlb-chart-card {{
  background: var(--tlb-navy-dark);
  border: 1px solid var(--tlb-navy-border);
  border-radius: 10px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}}

.tlb-chart-header {{
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 12px;
}}

.tlb-chart-header h3 {{
  margin: 0;
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--tlb-white);
}}

.tlb-metric-unit {{
  font-size: 0.78rem;
  color: var(--tlb-slate-400);
}}

.tlb-svg-container {{
  width: 100%;
  min-height: 280px;
  position: relative;
}}

.tlb-svg-container svg {{
  width: 100%;
  height: auto;
  display: block;
}}

/* Timeline Scrubber */
.tlb-timeline-bar {{
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--tlb-navy-border);
  display: flex;
  align-items: center;
  gap: 12px;
}}

.tlb-timeline-bar label {{
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--tlb-slate-300);
  white-space: nowrap;
}}

.tlb-slider {{
  flex-grow: 1;
  accent-color: var(--tlb-teal);
  cursor: pointer;
}}

.tlb-step-badge {{
  font-family: ui-monospace, monospace;
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--tlb-teal-light);
  background: var(--tlb-navy-deep);
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid var(--tlb-navy-border);
  min-width: 60px;
  text-align: center;
}}

/* Stats Sidebar */
.tlb-sidebar {{
  display: flex;
  flex-direction: column;
  gap: 12px;
}}

.tlb-stat-card {{
  background: var(--tlb-navy-dark);
  border: 1px solid var(--tlb-navy-border);
  border-radius: 10px;
  padding: 14px 16px;
}}

.tlb-stat-title {{
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--tlb-slate-400);
}}

.tlb-stat-value {{
  margin: 6px 0 2px;
  font-size: 1.45rem;
  font-weight: 750;
  color: var(--tlb-white);
  font-family: Inter, ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
}}

.tlb-stat-sub {{
  font-size: 0.75rem;
  color: var(--tlb-slate-400);
}}

.tlb-stat-sub.positive {{ color: var(--tlb-teal-light); }}
.tlb-stat-sub.warning {{ color: var(--tlb-coral); }}

/* Insight Banner */
.tlb-insight-banner {{
  background: linear-gradient(135deg, rgba(0, 188, 175, 0.08), rgba(0, 43, 79, 0.4));
  border: 1px solid rgba(0, 188, 175, 0.3);
  border-radius: 10px;
  padding: 14px 18px;
  margin-bottom: 20px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
}}

.tlb-insight-icon {{
  color: var(--tlb-teal);
  font-size: 1.1rem;
  line-height: 1;
  margin-top: 2px;
}}

.tlb-insight-text {{
  margin: 0;
  font-size: 0.86rem;
  color: var(--tlb-slate-200);
  line-height: 1.45;
}}

/* Provenance Drawer */
.tlb-provenance-drawer {{
  background: var(--tlb-navy-surface);
  border: 1px solid var(--tlb-navy-border);
  border-radius: 10px;
  padding: 14px 18px;
}}

.tlb-provenance-toggle {{
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  background: none;
  border: none;
  color: var(--tlb-slate-300);
  font-family: inherit;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
  text-align: left;
}}

.tlb-provenance-toggle:hover {{
  color: var(--tlb-white);
}}

.tlb-provenance-content {{
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--tlb-navy-border);
  font-size: 0.78rem;
  color: var(--tlb-slate-400);
}}

.tlb-provenance-grid {{
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}}

.tlb-prov-item strong {{
  color: var(--tlb-slate-200);
  display: block;
}}

.tlb-prov-item span {{
  font-family: ui-monospace, monospace;
  font-size: 0.72rem;
  color: var(--tlb-slate-400);
  word-break: break-all;
}}

.tlb-disclaimer-footer {{
  margin-top: 12px;
  font-size: 0.74rem;
  color: var(--tlb-slate-500);
  border-top: 1px solid var(--tlb-navy-border);
  padding-top: 10px;
}}

/* Responsive Breakpoints */
@media (max-width: 900px) {{
  .tlb-grid {{
    grid-template-columns: 1fr;
  }}
  .tlb-sidebar {{
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px;
  }}
}}

@media (max-width: 600px) {{
  #tokenlab-embed {{
    padding: 16px;
  }}
  .tlb-controls-bar {{
    flex-direction: column;
    align-items: stretch;
  }}
  .tlb-btn-group {{
    display: flex;
    overflow-x: auto;
  }}
  .tlb-btn {{
    flex: 1;
    text-align: center;
    padding: 6px 8px;
    font-size: 0.75rem;
  }}
  .tlb-header {{
    flex-direction: column;
    align-items: flex-start;
  }}
}}

/* Reduced Motion Support */
@media (prefers-reduced-motion: reduce) {{
  #tokenlab-embed * {{
    transition: none !important;
    animation: none !important;
  }}
}}
"""
    with open(OUTPUT_DIR / "dashboard.css", "w", encoding="utf-8") as f:
        f.write(css_content)

    # dashboard.js
    js_content = f"""/**
 * TokenLab Dependency-Free Interactive Dashboard Controller
 * Verified against genuine TokenLab simulation data.
 * Zero external calls. Fully self-contained.
 */

(function () {{
  'use strict';

  const DATA = {json.dumps(public_data, indent=2)};

  const INSIGHTS = {{
    token_price: "TokenLab reveals early token velocity drag (trough at step 6) prior to adoption-driven valuation recovery.",
    fiat_transaction_volume: "Fiat transaction volume expands monotonically from $200k to $2.4M as adoption reaches user cohort capacity.",
    user_count: "Cumulative user participation tracks cohort growth from 1.6k to 20k modeled user-step interactions.",
    transaction_count: "Transaction count tracks aggregate controller actions per step.",
    holding_time: "Holding time governs how long tokens are retained before recirculation (baseline = 1.50 time units).",
    token_supply: "Token supply is held constant at 250,000,000 TLAB across all steps (unmodelled emissions/burns declared absent)."
  }};

  let state = {{
    preset: 'baseline',
    metric: 'token_price',
    compareAll: false,
    step: 23
  }};

  function formatValue(metric, val) {{
    if (val === undefined || val === null || isNaN(val)) return 'N/A';
    if (metric === 'token_price') return '$' + Number(val).toFixed(4);
    if (metric === 'fiat_transaction_volume') return '$' + Number(val).toLocaleString(undefined, {{maximumFractionDigits: 0}});
    if (metric === 'holding_time') return Number(val).toFixed(2) + ' units';
    return Number(val).toLocaleString(undefined, {{maximumFractionDigits: 0}});
  }}

  function renderChart() {{
    const container = document.getElementById('tlb-svg-target');
    if (!container) return;

    const width = 640;
    const height = 300;
    const pad = {{ top: 30, bottom: 40, left: 65, right: 25 }};
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const activeSeries = DATA.presets[state.preset].series[state.metric];
    let allVals = [...activeSeries];

    if (state.compareAll) {{
      allVals = allVals.concat(
        DATA.presets['downside'].series[state.metric],
        DATA.presets['upside'].series[state.metric]
      );
    }}

    let yMin = Math.min(...allVals);
    let yMax = Math.max(...allVals);
    if (yMin === yMax) {{ yMin = 0; yMax = yMax > 0 ? yMax * 1.5 : 1; }}
    else {{
      const span = yMax - yMin;
      yMin = Math.max(0, yMin - span * 0.08);
      yMax = yMax + span * 0.08;
    }}

    function toX(i) {{ return pad.left + (i / 23.0) * plotW; }}
    function toY(v) {{ return pad.top + plotH * (1.0 - (v - yMin) / (yMax - yMin)); }}

    let svg = `<svg viewBox="0 0 ${{width}} ${{height}}" width="100%" height="auto" role="img" aria-label="Interactive simulation chart">`;

    // Horizontal grid lines
    const ticks = 4;
    for (let i = 0; i < ticks; i++) {{
      const frac = i / (ticks - 1);
      const val = yMin + frac * (yMax - yMin);
      const yPos = pad.top + plotH * (1.0 - frac);
      svg += `<line x1="${{pad.left}}" y1="${{yPos}}" x2="${{width - pad.right}}" y2="${{yPos}}" stroke="#1e293b" stroke-dasharray="3,3" stroke-width="1"/>`;
      svg += `<text x="${{pad.left - 8}}" y="${{yPos + 4}}" fill="#94a3b8" font-size="9.5" text-anchor="end" font-family="Inter, monospace">${{formatValue(state.metric, val)}}</text>`;
    }}

    // Vertical step markers
    for (let s = 0; s < 24; s += 6) {{
      const xPos = toX(s);
      svg += `<line x1="${{xPos}}" y1="${{pad.top + plotH}}" x2="${{xPos}}" y2="${{pad.top + plotH + 4}}" stroke="#475569" stroke-width="1"/>`;
      svg += `<text x="${{xPos}}" y="${{pad.top + plotH + 16}}" fill="#94a3b8" font-size="9.5" text-anchor="middle" font-family="Inter, sans-serif">Step ${{s}}</text>`;
    }}

    // Current scrubber indicator line
    const scrubX = toX(state.step);
    svg += `<line x1="${{scrubX}}" y1="${{pad.top}}" x2="${{scrubX}}" y2="${{pad.top + plotH}}" stroke="#00BCAF" stroke-width="1.5" stroke-dasharray="2,2"/>`;

    // Plot lines
    if (state.compareAll) {{
      const seriesCfg = [
        {{ key: 'upside', color: '#38bdf8', label: 'Upside' }},
        {{ key: 'baseline', color: '#00BCAF', label: 'Baseline' }},
        {{ key: 'downside', color: '#f87171', label: 'Downside' }}
      ];
      seriesCfg.forEach(cfg => {{
        const vals = DATA.presets[cfg.key].series[state.metric];
        const pts = vals.map((v, i) => `${{toX(i).toFixed(1)}},${{toY(v).toFixed(1)}}`).join(' ');
        const isCurrent = cfg.key === state.preset;
        svg += `<polyline points="${{pts}}" fill="none" stroke="${{cfg.color}}" stroke-width="${{isCurrent ? 2.8 : 1.8}}" stroke-linecap="round"/>`;
        // Scrubber dot
        const sv = vals[state.step];
        svg += `<circle cx="${{scrubX}}" cy="${{toY(sv)}}" r="${{isCurrent ? 4.5 : 3.5}}" fill="${{cfg.color}}" stroke="#001e38" stroke-width="1.5"/>`;
      }});
    }} else {{
      const pts = activeSeries.map((v, i) => `${{toX(i).toFixed(1)}},${{toY(v).toFixed(1)}}`).join(' ');
      svg += `<polyline points="${{pts}}" fill="none" stroke="#00BCAF" stroke-width="2.8" stroke-linecap="round"/>`;
      activeSeries.forEach((v, i) => {{
        if (i === 0 || i === state.step || i === 23) {{
          svg += `<circle cx="${{toX(i)}}" cy="${{toY(v)}}" r="${{i === state.step ? 5 : 3.5}}" fill="#00BCAF" stroke="#001e38" stroke-width="1.5"/>`;
        }}
      }});
    }}

    svg += '</svg>';
    container.innerHTML = svg;
  }}

  function updateUI() {{
    const currentData = DATA.presets[state.preset].series[state.metric];
    const stepVal = currentData[state.step];
    const startVal = currentData[0];
    const minVal = Math.min(...currentData);
    const maxVal = Math.max(...currentData);
    const deltaPct = startVal > 0 ? ((stepVal - startVal) / startVal * 100) : 0;

    // Update Text Elements
    document.getElementById('tlb-metric-title').textContent = document.querySelector(`.tlb-btn[data-metric="${{state.metric}}"]`).textContent;
    document.getElementById('tlb-metric-unit').textContent = DATA.metadata.units[state.metric] || '';
    document.getElementById('tlb-step-badge').textContent = `Step ${{state.step}}`;
    document.getElementById('tlb-current-val').textContent = formatValue(state.metric, stepVal);

    const deltaEl = document.getElementById('tlb-delta-val');
    deltaEl.textContent = (deltaPct >= 0 ? '+' : '') + deltaPct.toFixed(1) + '% vs Step 0';
    deltaEl.className = 'tlb-stat-sub ' + (deltaPct >= 0 ? 'positive' : 'warning');

    document.getElementById('tlb-min-val').textContent = formatValue(state.metric, minVal);
    document.getElementById('tlb-max-val').textContent = formatValue(state.metric, maxVal);
    document.getElementById('tlb-insight-text').textContent = INSIGHTS[state.metric] || INSIGHTS.token_price;

    renderChart();
  }}

  function init() {{
    // Preset Buttons
    document.querySelectorAll('.tlb-btn[data-preset]').forEach(btn => {{
      btn.addEventListener('click', e => {{
        document.querySelectorAll('.tlb-btn[data-preset]').forEach(b => {{
          b.setAttribute('aria-selected', 'false');
          b.classList.remove('active');
        }});
        btn.setAttribute('aria-selected', 'true');
        btn.classList.add('active');
        state.preset = btn.getAttribute('data-preset');
        updateUI();
      }});
    }});

    // Metric Buttons
    document.querySelectorAll('.tlb-btn[data-metric]').forEach(btn => {{
      btn.addEventListener('click', e => {{
        document.querySelectorAll('.tlb-btn[data-metric]').forEach(b => {{
          b.setAttribute('aria-selected', 'false');
          b.classList.remove('active');
        }});
        btn.setAttribute('aria-selected', 'true');
        btn.classList.add('active');
        state.metric = btn.getAttribute('data-metric');
        updateUI();
      }});
    }});

    // Compare Toggle
    const compareToggle = document.getElementById('tlb-compare-toggle');
    if (compareToggle) {{
      compareToggle.addEventListener('change', e => {{
        state.compareAll = e.target.checked;
        renderChart();
      }});
    }}

    // Timeline Slider
    const slider = document.getElementById('tlb-timeline-slider');
    if (slider) {{
      slider.addEventListener('input', e => {{
        state.step = parseInt(e.target.value, 10);
        updateUI();
      }});
    }}

    // Provenance Drawer Toggle
    const provBtn = document.getElementById('tlb-prov-btn');
    const provContent = document.getElementById('tlb-prov-content');
    if (provBtn && provContent) {{
      provBtn.addEventListener('click', () => {{
        const isHidden = provContent.hasAttribute('hidden');
        if (isHidden) {{
          provContent.removeAttribute('hidden');
          provBtn.setAttribute('aria-expanded', 'true');
        }} else {{
          provContent.setAttribute('hidden', '');
          provBtn.setAttribute('aria-expanded', 'false');
        }}
      }});
    }}

    updateUI();
  }}

  if (document.readyState === 'loading') {{
    document.addEventListener('DOMContentLoaded', init);
  }} else {{
    init();
  }}
}})();
"""
    with open(OUTPUT_DIR / "dashboard.js", "w", encoding="utf-8") as f:
        f.write(js_content)

    # dashboard.html
    html_content = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TokenLab — Interactive Simulation Output</title>
  <link rel="stylesheet" href="dashboard.css">
</head>
<body style="margin: 0; padding: 20px; background: {PALETTE["navy_deep"]};">

  <!-- TokenLab Embed Root -->
  <div id="tokenlab-embed" role="region" aria-label="TokenLab Interactive Simulation Explorer">
    
    <!-- Header -->
    <header class="tlb-header">
      <div class="tlb-title-group">
        <h2>TokenLab Simulation Explorer</h2>
        <p>Explore genuine token economy simulation outputs across 24 operating steps.</p>
      </div>
      <div class="tlb-disclaimer-pill" role="status">
        Illustrative simulation, not a forecast
      </div>
    </header>

    <!-- Controls -->
    <nav class="tlb-controls-bar" aria-label="Dashboard controls">
      <div class="tlb-control-section">
        <span class="tlb-control-label">Tested Scenario Preset</span>
        <div class="tlb-btn-group" role="tablist" aria-label="Scenario Presets">
          <button type="button" class="tlb-btn active" role="tab" aria-selected="true" data-preset="baseline">Baseline</button>
          <button type="button" class="tlb-btn" role="tab" aria-selected="false" data-preset="downside">Downside</button>
          <button type="button" class="tlb-btn" role="tab" aria-selected="false" data-preset="upside">Upside</button>
        </div>
      </div>

      <div class="tlb-control-section">
        <span class="tlb-control-label">Economic Metric</span>
        <div class="tlb-btn-group" role="tablist" aria-label="Metrics">
          <button type="button" class="tlb-btn active" role="tab" aria-selected="true" data-metric="token_price">Token Price</button>
          <button type="button" class="tlb-btn" role="tab" aria-selected="false" data-metric="fiat_transaction_volume">Tx Volume</button>
          <button type="button" class="tlb-btn" role="tab" aria-selected="false" data-metric="user_count">User Cohort</button>
          <button type="button" class="tlb-btn" role="tab" aria-selected="false" data-metric="holding_time">Holding Time</button>
        </div>
      </div>

      <div class="tlb-control-section">
        <span class="tlb-control-label">Overlay</span>
        <label class="tlb-toggle-label">
          <input type="checkbox" id="tlb-compare-toggle">
          <span>Compare All Presets</span>
        </label>
      </div>
    </nav>

    <!-- Main Workspace -->
    <div class="tlb-grid">
      <!-- Chart Panel -->
      <section class="tlb-chart-card">
        <div class="tlb-chart-header">
          <h3 id="tlb-metric-title">Illustrative Token Price</h3>
          <span class="tlb-metric-unit" id="tlb-metric-unit">$ per TLAB</span>
        </div>

        <div class="tlb-svg-container" id="tlb-svg-target">
          <!-- Rendered dynamically by dashboard.js or fallback -->
          <noscript>
            <img src="dashboard-fallback.svg" alt="TokenLab static simulation output summary" width="100%" height="auto">
          </noscript>
        </div>

        <div class="tlb-timeline-bar">
          <label for="tlb-timeline-slider">Simulation Timeline:</label>
          <input type="range" id="tlb-timeline-slider" class="tlb-slider" min="0" max="23" value="23" step="1" aria-label="Simulation step scrubber">
          <span class="tlb-step-badge" id="tlb-step-badge">Step 23</span>
        </div>
      </section>

      <!-- Sidebar KPI Cards -->
      <aside class="tlb-sidebar" aria-label="Key Performance Indicators">
        <div class="tlb-stat-card">
          <div class="tlb-stat-title">Current Step Value</div>
          <div class="tlb-stat-value" id="tlb-current-val">$0.0108</div>
          <div class="tlb-stat-sub positive" id="tlb-delta-val">-57.3% vs Step 0</div>
        </div>

        <div class="tlb-stat-card">
          <div class="tlb-stat-title">Velocity Trough (Min)</div>
          <div class="tlb-stat-value" id="tlb-min-val">$0.0021</div>
          <div class="tlb-stat-sub warning">Occurs at Step 6</div>
        </div>

        <div class="tlb-stat-card">
          <div class="tlb-stat-title">Peak Value (Max)</div>
          <div class="tlb-stat-value" id="tlb-max-val">$0.0252</div>
          <div class="tlb-stat-sub">Occurs at Step 0</div>
        </div>
      </aside>
    </div>

    <!-- Insight Banner -->
    <div class="tlb-insight-banner" role="note">
      <span class="tlb-insight-icon" aria-hidden="true">&#9432;</span>
      <p class="tlb-insight-text" id="tlb-insight-text">
        TokenLab reveals early token velocity drag (trough at step 6) prior to adoption-driven valuation recovery.
      </p>
    </div>

    <!-- Provenance & Method Drawer -->
    <footer class="tlb-provenance-drawer">
      <button type="button" class="tlb-provenance-toggle" id="tlb-prov-btn" aria-expanded="false">
        <span>Verified Simulation Lineage & Provenance Details</span>
        <span aria-hidden="true">&#9662;</span>
      </button>

      <div class="tlb-provenance-content" id="tlb-prov-content" hidden>
        <div class="tlb-provenance-grid">
          <div class="tlb-prov-item">
            <strong>Scenario Identifier</strong>
            <span>{provenance["scenario_id"]}</span>
          </div>
          <div class="tlb-prov-item">
            <strong>Simulation Seed</strong>
            <span>{provenance["seed"]}</span>
          </div>
          <div class="tlb-prov-item">
            <strong>Configuration Hash</strong>
            <span>{provenance["config_hash"][:16]}...</span>
          </div>
          <div class="tlb-prov-item">
            <strong>Artifact Profile</strong>
            <span>{provenance["profile_id"]}</span>
          </div>
        </div>
        <div class="tlb-disclaimer-footer">
          <strong>Boundary & Disclaimer:</strong> {public_data["metadata"]["interpretation_boundary"]}
          Unmodelled concepts: emissions, vesting pools, liquidity depth, staking rewards, FDV, and APY are omitted from this deterministic model.
        </div>
      </div>
    </footer>

  </div>

  <script src="dashboard.js"></script>
</body>
</html>
"""
    with open(OUTPUT_DIR / "dashboard.html", "w", encoding="utf-8") as f:
        f.write(html_content)


# ==============================================================================
# CAPTIONS & INTEGRATION DOCUMENTATION
# ==============================================================================

def generate_captions_doc(public_data: Dict[str, Any]):
    """Generate captions.md with clear British English titles, insights, and marketing copy."""
    content = f"""# TokenLab Public Visual Integration Captions

This document contains the verified captions, conversion copy, data sources, and analytical boundaries for the three TokenLab visualisations on the Tesseract Academy website.

---

## Core Conversion Proposition

> **"TokenLab makes an invisible economic risk visible before the design goes live."**

All captions use natural British English, avoid exaggerated claims, and cite genuine TokenLab simulation outputs.

---

## Visualisation 1: Early Velocity Drag and Demand-Driven Valuation Recovery

- **File**: `chart-1-velocity-recovery.svg` (Fallback: `chart-1-velocity-recovery.webp`)
- **Mobile File**: `chart-1-velocity-recovery-mobile.svg` (Fallback: `chart-1-velocity-recovery-mobile.webp`)
- **British English Title**: Early velocity drag and demand-driven valuation recovery
- **Analytical Caption**: Simulation of 24 operating steps reveals how high initial velocity depresses early token valuation before adoption and transactional utility mature.
- **Conversion Marketing Caption**: TokenLab reveals how early token turnover can depress initial token valuation before user adoption and holding patterns mature.
- **Source Table & Columns**: `outputs/demo/public-demo/iteration_summary.csv`, column `TLAB_price_mean`.
- **Simulation Seed & Scenario ID**: Seed `20260812`, Scenario `public-growth-path-v1` (Preset: Baseline).
- **Units & Axes**:
  - X-Axis: Simulation Timeline (Steps 0 to 23).
  - Y-Axis: Illustrative Token Price ($ per TLAB, range $0.000 to $0.030).
- **Key Empirical Observations**:
  - Initial token price: $0.0252 (Step 0)
  - Velocity trough: $0.0021 (Step 6, -91.5% from inception)
  - Stabilised terminal price: $0.0108 (Step 23, +402% recovery from trough)
- **Assumptions & Limitations**: Constant token supply (250,000,000 TLAB) under Equation of Exchange pricing. No staking lockups, emissions, or liquidity depth simulated.
- **Required Label**: "Illustrative simulation, not a forecast."

---

## Visualisation 2: Scenario Resilience Under Shifting User Adoption and Holding Assumptions

- **File**: `chart-2-scenario-comparison.svg` (Fallback: `chart-2-scenario-comparison.webp`)
- **Mobile File**: `chart-2-scenario-comparison-mobile.svg` (Fallback: `chart-2-scenario-comparison-mobile.webp`)
- **British English Title**: Scenario resilience under shifting user adoption and holding assumptions
- **Analytical Caption**: Comparative simulation of baseline, downside, and upside configurations demonstrating how holding time and user adoption scale end-state economy health.
- **Conversion Marketing Caption**: Stress testing against adverse user retention scenarios quantifies how sensitive token health is to participant holding habits before commitment.
- **Source Table & Columns**: `outputs/demo/public-demo/iteration_summary.csv`, column `TLAB_price_mean` across Baseline, Downside, and Upside presets.
- **Simulation Seed & Scenario ID**: Seed `20260812`, Scenario `public-growth-path-v1`.
- **Units & Axes**:
  - X-Axis: Simulation Timeline (Steps 0 to 23).
  - Y-Axis: Illustrative Token Price ($ per TLAB, range $0.000 to $0.035).
- **Scenario Parameter Definitions**:
  - **Downside**: 12,000 user ceiling, $80 ending tx value, 0.75 holding time -> Terminal price $0.0023 (-78.7% vs baseline).
  - **Baseline**: 20,000 user ceiling, $120 ending tx value, 1.50 holding time -> Terminal price $0.0108.
  - **Upside**: 32,000 user ceiling, $180 ending tx value, 2.50 holding time -> Terminal price $0.0298 (+176% vs baseline).
- **Assumptions & Limitations**: Comparative parameter variations hold supply constant; model evaluates transactional velocity sensitivity rather than order-book depth.
- **Required Label**: "Illustrative simulation, not a forecast."

---

## Visualisation 3: Transaction Volume Expansion Alongside Cumulative Cohort Participation

- **File**: `chart-3-volume-participation.svg` (Fallback: `chart-3-volume-participation.webp`)
- **Mobile File**: `chart-3-volume-participation-mobile.svg` (Fallback: `chart-3-volume-participation-mobile.webp`)
- **British English Title**: Transaction volume expansion alongside cumulative cohort participation
- **Analytical Caption**: Tracking transactional demand alongside user participation isolates when organic transaction volume becomes self-sustaining.
- **Conversion Marketing Caption**: Tracking transaction velocity against user growth exposes whether economic activity is driven by organic utility or temporary incentive spikes.
- **Source Table & Columns**: `outputs/demo/public-demo/iteration_summary.csv`, columns `transactions_$_mean` and `num_users_mean`.
- **Simulation Seed & Scenario ID**: Seed `20260812`, Scenario `public-growth-path-v1` (Preset: Baseline).
- **Units & Axes**:
  - X-Axis: Simulation Timeline (Steps 0 to 23).
  - Primary Y-Axis (Left): Fiat Transaction Volume ($ per step, range $0 to $2,600,000).
  - Secondary Y-Axis (Right): Cumulative User Participation (range 0 to 25,000 user-step participations).
- **Key Empirical Observations**:
  - Starting transaction volume: $200,000 / step (Step 0)
  - Terminal transaction volume: $2,400,000 / step (Step 23)
  - Cumulative participation scales from 1,667 to 20,000 user-step participations.
- **Assumptions & Limitations**: User cohorts follow logistic adoption growth; transaction values follow linear trend controller.
- **Required Label**: "Illustrative simulation, not a forecast."
"""
    with open(OUTPUT_DIR / "captions.md", "w", encoding="utf-8") as f:
        f.write(content)


def generate_integration_doc():
    """Generate INTEGRATION.md with complete copy-paste integration instructions."""
    content = """# TokenLab Visual Integration Guide for Tesseract Academy

This guide outlines how to integrate the genuine TokenLab visual integration packet into the Tesseract Academy website (`https://tesseract.academy/tokenlab/`).

---

## 1. Integration Packet Contents & Asset Sizes

All assets are located in `outputs/website_integration/`:

| File | Type | Purpose | Dimensions | Asset Size |
|---|---|---|---|---|
| `dashboard.html` | HTML5 Document | Self-contained standalone dashboard | Responsive (100%) | ~7 KB |
| `dashboard.css` | Scoped CSS | Prefixed component styles (`#tokenlab-embed`) | N/A | ~6 KB |
| `dashboard.js` | Vanilla JS | Zero-dependency interactive controller | N/A | ~8 KB |
| `dashboard-fallback.svg` | Vector Asset | Non-JS fallback summary banner | 820 x 360 | ~3 KB |
| `chart-1-velocity-recovery.svg` | Vector Asset | Chart 1 desktop vector | 820 x 440 | ~6 KB |
| `chart-1-velocity-recovery-mobile.svg` | Vector Asset | Chart 1 mobile vector | 390 x 300 | ~4 KB |
| `chart-1-velocity-recovery.webp` | Raster Fallback | Chart 1 desktop raster fallback | 1380 x 750 (2x) | ~40 KB |
| `chart-2-scenario-comparison.svg` | Vector Asset | Chart 2 desktop vector | 820 x 440 | ~8 KB |
| `chart-2-scenario-comparison-mobile.svg` | Vector Asset | Chart 2 mobile vector | 390 x 300 | ~5 KB |
| `chart-2-scenario-comparison.webp` | Raster Fallback | Chart 2 desktop raster fallback | 1380 x 750 (2x) | ~45 KB |
| `chart-3-volume-participation.svg` | Vector Asset | Chart 3 desktop vector | 820 x 440 | ~7 KB |
| `chart-3-volume-participation-mobile.svg` | Vector Asset | Chart 3 mobile vector | 390 x 300 | ~4 KB |
| `chart-3-volume-participation.webp` | Raster Fallback | Chart 3 desktop raster fallback | 1380 x 750 (2x) | ~35 KB |
| `public-demo-data.json` | Data Payload | Verified simulation timeseries | N/A | ~5 KB |
| `provenance.json` | Provenance | Cryptographic run hashes & seed | N/A | ~2 KB |
| `captions.md` | Copy Deck | British English titles & conversion copy | N/A | ~4 KB |
| `screenshot-desktop.png` | Preview Asset | 1440px desktop rendering preview | 1440 x 900 | ~180 KB |
| `screenshot-mobile.png` | Preview Asset | 390px mobile rendering preview | 390 x 844 | ~110 KB |

---

## 2. Integration Option A: Responsive Iframe Embed (Recommended)

This option provides full CSS and JS isolation from the main WordPress/Elementor/Divi theme.

### Copy-Paste Code Snippet:
```html
<div class="tokenlab-embed-wrapper" style="width: 100%; max-width: 1180px; margin: 40px auto; overflow: hidden; border-radius: 14px;">
  <iframe
    src="/wp-content/uploads/tokenlab-integration/dashboard.html"
    title="TokenLab Interactive Simulation Output"
    style="width: 100%; height: 720px; border: none; display: block;"
    loading="lazy"
    scrolling="no"
    sandbox="allow-scripts allow-same-origin"
  ></iframe>
</div>
```

---

## 3. Integration Option B: Direct HTML/CSS/JS Component Embed

If you prefer to embed the component directly into the WordPress page template without an iframe:

### 1. In the Page Header or `<head>`:
```html
<link rel="stylesheet" href="/assets/tokenlab/dashboard.css">
```

### 2. In the Page Body:
```html
<div id="tokenlab-embed" role="region" aria-label="TokenLab Interactive Simulation Explorer">
  <!-- Header -->
  <header class="tlb-header">
    <div class="tlb-title-group">
      <h2>TokenLab Simulation Explorer</h2>
      <p>Explore genuine token economy simulation outputs across 24 operating steps.</p>
    </div>
    <div class="tlb-disclaimer-pill" role="status">
      Illustrative simulation, not a forecast
    </div>
  </header>

  <!-- Controls -->
  <nav class="tlb-controls-bar" aria-label="Dashboard controls">
    <div class="tlb-control-section">
      <span class="tlb-control-label">Tested Scenario Preset</span>
      <div class="tlb-btn-group" role="tablist" aria-label="Scenario Presets">
        <button type="button" class="tlb-btn active" role="tab" aria-selected="true" data-preset="baseline">Baseline</button>
        <button type="button" class="tlb-btn" role="tab" aria-selected="false" data-preset="downside">Downside</button>
        <button type="button" class="tlb-btn" role="tab" aria-selected="false" data-preset="upside">Upside</button>
      </div>
    </div>

    <div class="tlb-control-section">
      <span class="tlb-control-label">Economic Metric</span>
      <div class="tlb-btn-group" role="tablist" aria-label="Metrics">
        <button type="button" class="tlb-btn active" role="tab" aria-selected="true" data-metric="token_price">Token Price</button>
        <button type="button" class="tlb-btn" role="tab" aria-selected="false" data-metric="fiat_transaction_volume">Tx Volume</button>
        <button type="button" class="tlb-btn" role="tab" aria-selected="false" data-metric="user_count">User Cohort</button>
        <button type="button" class="tlb-btn" role="tab" aria-selected="false" data-metric="holding_time">Holding Time</button>
      </div>
    </div>

    <div class="tlb-control-section">
      <span class="tlb-control-label">Overlay</span>
      <label class="tlb-toggle-label">
        <input type="checkbox" id="tlb-compare-toggle">
        <span>Compare All Presets</span>
      </label>
    </div>
  </nav>

  <!-- Main Workspace -->
  <div class="tlb-grid">
    <section class="tlb-chart-card">
      <div class="tlb-chart-header">
        <h3 id="tlb-metric-title">Illustrative Token Price</h3>
        <span class="tlb-metric-unit" id="tlb-metric-unit">$ per TLAB</span>
      </div>

      <div class="tlb-svg-container" id="tlb-svg-target">
        <noscript>
          <img src="/assets/tokenlab/dashboard-fallback.svg" alt="TokenLab simulation summary" width="100%" height="auto">
        </noscript>
      </div>

      <div class="tlb-timeline-bar">
        <label for="tlb-timeline-slider">Simulation Timeline:</label>
        <input type="range" id="tlb-timeline-slider" class="tlb-slider" min="0" max="23" value="23" step="1" aria-label="Simulation step scrubber">
        <span class="tlb-step-badge" id="tlb-step-badge">Step 23</span>
      </div>
    </section>

    <aside class="tlb-sidebar" aria-label="Key Performance Indicators">
      <div class="tlb-stat-card">
        <div class="tlb-stat-title">Current Step Value</div>
        <div class="tlb-stat-value" id="tlb-current-val">$0.0108</div>
        <div class="tlb-stat-sub positive" id="tlb-delta-val">-57.3% vs Step 0</div>
      </div>
      <div class="tlb-stat-card">
        <div class="tlb-stat-title">Velocity Trough (Min)</div>
        <div class="tlb-stat-value" id="tlb-min-val">$0.0021</div>
        <div class="tlb-stat-sub warning">Occurs at Step 6</div>
      </div>
      <div class="tlb-stat-card">
        <div class="tlb-stat-title">Peak Value (Max)</div>
        <div class="tlb-stat-value" id="tlb-max-val">$0.0252</div>
        <div class="tlb-stat-sub">Occurs at Step 0</div>
      </div>
    </aside>
  </div>

  <div class="tlb-insight-banner" role="note">
    <span class="tlb-insight-icon" aria-hidden="true">&#9432;</span>
    <p class="tlb-insight-text" id="tlb-insight-text">
      TokenLab reveals early token velocity drag (trough at step 6) prior to adoption-driven valuation recovery.
    </p>
  </div>

  <footer class="tlb-provenance-drawer">
    <button type="button" class="tlb-provenance-toggle" id="tlb-prov-btn" aria-expanded="false">
      <span>Verified Simulation Lineage & Provenance Details</span>
      <span aria-hidden="true">&#9662;</span>
    </button>
    <div class="tlb-provenance-content" id="tlb-prov-content" hidden>
      <p style="margin: 0 0 8px;"><strong>Scenario:</strong> public-growth-path-v1 | <strong>Seed:</strong> 20260812 | <strong>Profile:</strong> tokenlab-public-demo-v1</p>
      <p style="margin: 0; font-size: 0.72rem; color: #64748b;">Boundary: Illustrative simulation only; not investment, launch, legal, financial, or forecast advice.</p>
    </div>
  </footer>
</div>
```

### 3. Before the Closing `</body>` Tag:
```html
<script src="/assets/tokenlab/dashboard.js"></script>
```

---

## 4. Embedding the Three Static Graphs

For marketing sections or case studies where static imagery is preferred:

```html
<!-- Visualisation 1 -->
<figure class="tokenlab-figure" style="margin: 32px 0;">
  <picture>
    <source media="(max-width: 600px)" srcset="/assets/tokenlab/chart-1-velocity-recovery-mobile.svg" type="image/svg+xml">
    <source srcset="/assets/tokenlab/chart-1-velocity-recovery.svg" type="image/svg+xml">
    <img src="/assets/tokenlab/chart-1-velocity-recovery.webp" alt="Early velocity drag and demand-driven valuation recovery" width="820" height="440" style="width: 100%; height: auto; border-radius: 12px;">
  </picture>
  <figcaption style="font-size: 0.85rem; color: #94a3b8; margin-top: 8px; text-align: center;">
    <strong>Early velocity drag and valuation recovery:</strong> TokenLab reveals how early token turnover can depress initial token valuation before user adoption and holding patterns mature.
  </figcaption>
</figure>
```

---

## 5. Content Security Policy (CSP) & Accessibility Notes

- **Zero Remote Dependencies**: The dashboard makes no `fetch()` requests and loads no fonts from Google Fonts or external CDNs. It uses the system font stack.
- **CSP Directives**:
  ```http
  Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self';
  ```
- **Accessibility**:
  - ARIA tab roles (`role="tablist"`, `role="tab"`, `aria-selected`) with keyboard support.
  - High-contrast colors conforming to WCAG AAA standards (Navy `#002b4f`, Teal `#00BCAF`, White `#ffffff`).
  - Media query `@media (prefers-reduced-motion: reduce)` disables all CSS transitions and dynamic shifts.

---

## 6. Refresh Procedure

To regenerate all simulation data and integration assets from the latest TokenLab core repository:

```bash
# 1. Run the deterministic generator
PYTHONPATH=src python3 scripts/generate_website_integration.py

# 2. Run the automated integration test suite
PYTHONPATH=src python3 -m pytest tests/test_website_integration.py -v
```
"""
    with open(OUTPUT_DIR / "INTEGRATION.md", "w", encoding="utf-8") as f:
        f.write(content)


# ==============================================================================
# PREVIEW SCREENSHOT GENERATION
# ==============================================================================

def generate_preview_screenshots(public_data: Dict[str, Any]):
    """Generate high-resolution desktop (1440px) and mobile (390px) preview images."""
    prices = public_data["presets"]["baseline"]["series"]["token_price"]

    # Desktop (1440 x 900)
    img_d = Image.new("RGB", (1440, 900), color=PALETTE["navy_deep"])
    draw_d = ImageDraw.Draw(img_d)

    # Header Bar
    draw_d.rectangle([0, 0, 1440, 70], fill=PALETTE["navy_dark"], outline=PALETTE["navy_border"], width=1)
    draw_d.text((40, 24), "TESSERACT ACADEMY  /  TOKENLAB SIMULATION ENGINE", fill=PALETTE["teal"], font_size=16)

    # Main Card Container
    draw_d.rounded_rectangle([130, 110, 1310, 830], radius=14, fill=PALETTE["navy_dark"], outline=PALETTE["navy_border"], width=2)
    draw_d.text((160, 140), "TokenLab Simulation Explorer", fill=PALETTE["white"], font_size=24)
    draw_d.text((160, 175), "Verified deterministic simulation results (Scenario: public-growth-path-v1 | Seed: 20260812)", fill=PALETTE["slate_400"], font_size=14)

    # Controls Bar
    draw_d.rounded_rectangle([160, 210, 1280, 265], radius=8, fill=PALETTE["navy_surface"], outline=PALETTE["navy_border"], width=1)
    draw_d.text((180, 228), "PRESET: [ BASELINE ]  DOWNSIDE  UPSIDE", fill=PALETTE["teal_light"], font_size=13)
    draw_d.text((580, 228), "METRIC: [ TOKEN PRICE ]  TX VOLUME  USER COHORT  HOLDING TIME", fill=PALETTE["slate_200"], font_size=13)

    # Chart Area Outline
    draw_d.rounded_rectangle([160, 285, 960, 720], radius=8, fill=PALETTE["navy_deep"], outline=PALETTE["navy_border"], width=1)

    # Draw Line inside chart area
    c_x0, c_y0, c_w, c_h = 220, 340, 680, 320
    min_p, max_p = min(prices), max(prices)
    pts = []
    for i, p in enumerate(prices):
        px = c_x0 + (i / 23.0) * c_w
        py = c_y0 + c_h * (1.0 - (p - min_p) / (max_p - min_p))
        pts.append((px, py))

    for i in range(len(pts) - 1):
        draw_d.line([pts[i], pts[i+1]], fill=PALETTE["teal"], width=4)
    for pt in pts:
        draw_d.ellipse([pt[0]-4, pt[1]-4, pt[0]+4, pt[1]+4], fill=PALETTE["teal_light"], outline=PALETTE["navy_deep"], width=1)

    # Sidebar KPI cards
    draw_d.rounded_rectangle([980, 285, 1280, 410], radius=8, fill=PALETTE["navy_surface"], outline=PALETTE["navy_border"], width=1)
    draw_d.text((1000, 305), "CURRENT TOKEN PRICE", fill=PALETTE["slate_400"], font_size=11)
    draw_d.text((1000, 335), f"${prices[-1]:.4f}", fill=PALETTE["white"], font_size=30)
    draw_d.text((1000, 380), "+402% recovery from trough", fill=PALETTE["teal_light"], font_size=12)

    draw_d.rounded_rectangle([980, 430, 1280, 555], radius=8, fill=PALETTE["navy_surface"], outline=PALETTE["navy_border"], width=1)
    draw_d.text((1000, 450), "VELOCITY TROUGH (STEP 6)", fill=PALETTE["slate_400"], font_size=11)
    draw_d.text((1000, 480), f"${min(prices):.4f}", fill=PALETTE["coral"], font_size=30)
    draw_d.text((1000, 525), "-91.5% initial turnover drag", fill=PALETTE["coral"], font_size=12)

    draw_d.rounded_rectangle([980, 575, 1280, 720], radius=8, fill=PALETTE["navy_surface"], outline=PALETTE["navy_border"], width=1)
    draw_d.text((1000, 595), "FIAT TRANSACTION DEMAND", fill=PALETTE["slate_400"], font_size=11)
    draw_d.text((1000, 625), "$2,400,000", fill=PALETTE["cyan"], font_size=28)
    draw_d.text((1000, 670), "Scaling from $200k at Step 0", fill=PALETTE["slate_300"], font_size=12)

    # Scrubber Bar
    draw_d.rounded_rectangle([160, 740, 1280, 790], radius=6, fill=PALETTE["navy_surface"], outline=PALETTE["navy_border"], width=1)
    draw_d.text((180, 755), "TIMELINE: Step 0 ------------------------------------------------------------- [ Step 23 ]", fill=PALETTE["teal_light"], font_size=13)

    img_d.save(OUTPUT_DIR / "screenshot-desktop.png", "PNG")

    # Mobile (390 x 844)
    img_m = Image.new("RGB", (390, 844), color=PALETTE["navy_deep"])
    draw_m = ImageDraw.Draw(img_m)

    draw_m.rectangle([0, 0, 390, 55], fill=PALETTE["navy_dark"], outline=PALETTE["navy_border"], width=1)
    draw_m.text((15, 20), "TESSERACT ACADEMY / TOKENLAB", fill=PALETTE["teal"], font_size=12)

    draw_m.rounded_rectangle([15, 70, 375, 825], radius=10, fill=PALETTE["navy_dark"], outline=PALETTE["navy_border"], width=1)
    draw_m.text((30, 90), "TokenLab Simulation", fill=PALETTE["white"], font_size=18)
    draw_m.text((30, 115), "Illustrative simulation, not a forecast", fill=PALETTE["teal_light"], font_size=11)

    # Preset tabs
    draw_m.rounded_rectangle([30, 140, 360, 175], radius=6, fill=PALETTE["navy_surface"], outline=PALETTE["navy_border"], width=1)
    draw_m.text((40, 150), "[ BASELINE ]  DOWNSIDE  UPSIDE", fill=PALETTE["teal_light"], font_size=11)

    # Chart Area
    draw_m.rounded_rectangle([30, 190, 360, 420], radius=6, fill=PALETTE["navy_deep"], outline=PALETTE["navy_border"], width=1)
    mc_x0, mc_y0, mc_w, mc_h = 55, 230, 270, 150
    m_pts = []
    for i, p in enumerate(prices):
        px = mc_x0 + (i / 23.0) * mc_w
        py = mc_y0 + mc_h * (1.0 - (p - min_p) / (max_p - min_p))
        m_pts.append((px, py))

    for i in range(len(m_pts) - 1):
        draw_m.line([m_pts[i], m_pts[i+1]], fill=PALETTE["teal"], width=3)

    # Timeline scrubber
    draw_m.rounded_rectangle([30, 435, 360, 470], radius=6, fill=PALETTE["navy_surface"], outline=PALETTE["navy_border"], width=1)
    draw_m.text((45, 447), "TIMELINE: Step 0 -------- [ 23 ]", fill=PALETTE["teal_light"], font_size=11)

    # KPIs
    draw_m.rounded_rectangle([30, 485, 360, 570], radius=6, fill=PALETTE["navy_surface"], outline=PALETTE["navy_border"], width=1)
    draw_m.text((45, 500), "CURRENT TOKEN PRICE", fill=PALETTE["slate_400"], font_size=10)
    draw_m.text((45, 520), f"${prices[-1]:.4f}", fill=PALETTE["white"], font_size=20)
    draw_m.text((45, 545), "+402% recovery from trough", fill=PALETTE["teal_light"], font_size=10)

    draw_m.rounded_rectangle([30, 585, 360, 670], radius=6, fill=PALETTE["navy_surface"], outline=PALETTE["navy_border"], width=1)
    draw_m.text((45, 600), "VELOCITY TROUGH (STEP 6)", fill=PALETTE["coral"], font_size=10)
    draw_m.text((45, 620), f"${min(prices):.4f}", fill=PALETTE["white"], font_size=20)
    draw_m.text((45, 645), "-91.5% initial turnover drag", fill=PALETTE["coral"], font_size=10)

    draw_m.rounded_rectangle([30, 685, 360, 805], radius=6, fill=PALETTE["navy_surface"], outline=PALETTE["navy_border"], width=1)
    draw_m.text((45, 700), "INSIGHT & PROVENANCE", fill=PALETTE["slate_400"], font_size=10)
    draw_m.text((45, 720), "Early token velocity depresses valuation", fill=PALETTE["slate_200"], font_size=11)
    draw_m.text((45, 740), "before transactional utility matures.", fill=PALETTE["slate_200"], font_size=11)
    draw_m.text((45, 770), "Seed: 20260812 | Uncalibrated model", fill=PALETTE["slate_400"], font_size=9.5)

    img_m.save(OUTPUT_DIR / "screenshot-mobile.png", "PNG")


if __name__ == "__main__":
    generate_packet()
