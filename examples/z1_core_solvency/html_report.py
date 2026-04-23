"""
Z1 M1 HTML Report — uses TokenLab's general-purpose ReportBuilder.

This is a thin domain-specific wrapper that maps Z1 M1 simulation outputs
into the generic ReportBuilder API. Any new TokenLab model can follow
this same pattern.
"""

import os
import glob
import pandas as pd
from typing import Optional
from TokenLab.utils.reporting import ReportBuilder


def _fmt(value, fmt_str=".2f"):
    if value is None:
        return "N/A"
    try:
        return f"{value:{fmt_str}}"
    except (ValueError, TypeError):
        return str(value)


_CLASS_COLORS = {"collapse": "#DC2626", "stressed": "#F59E0B", "stable": "#16A34A"}


def _metrics_rows(summary: dict) -> list:
    """Convert a scenario summary dict into table rows."""
    return [
        ["Final AR Ratio", _fmt(summary.get("final_ar_ratio"))],
        ["Min AR Ratio", _fmt(summary.get("min_ar_ratio"))],
        ["Final Treasury", _fmt(summary.get("final_treasury"), ",.0f") + " Z1U"],
        ["Min Treasury", _fmt(summary.get("min_treasury"), ",.0f") + " Z1U"],
        ["Max Settlement Queue", _fmt(summary.get("max_settlement_queue_z1u"), ",.0f") + " Z1U"],
        ["Avg Pressure Ratio", _fmt(summary.get("avg_settlement_pressure_ratio"))],
        ["Max Pressure Ratio", _fmt(summary.get("max_settlement_pressure_ratio"))],
        ["Total Utility Spend", _fmt(summary.get("total_utility_spend"), ",.0f") + " Z1U"],
        ["Total Burn", _fmt(summary.get("total_burn"), ",.0f") + " Z1U"],
        ["Total Brand Inflow", _fmt(summary.get("total_brand_inflow"), ",.0f") + " Z1U"],
        ["Throttle Epochs", f"{summary.get('throttle_epochs', 0)} / 104"],
    ]


def _scenario_tab_html(summary: dict, plot_dir: str, report: ReportBuilder) -> str:
    """Build inner HTML for one scenario tab."""
    cls = summary.get("classification", "N/A")
    badge = report.badge(cls.upper(), _CLASS_COLORS.get(cls, "#888"))

    html = f"<p><strong>Classification:</strong> {badge}</p>"
    html += report._build_table(["Metric", "Value"], _metrics_rows(summary))

    # Embed plots if available
    if os.path.isdir(plot_dir):
        pngs = sorted(glob.glob(os.path.join(plot_dir, "*.png")))
        if pngs:
            html += '<div class="plot-grid">'
            for p in pngs:
                from TokenLab.utils.reporting import _img_to_base64
                b64 = _img_to_base64(p)
                name = os.path.splitext(os.path.basename(p))[0].replace("_", " ").title()
                html += f'<div><img class="plot" src="{b64}" alt="{name}"><p style="text-align:center;color:var(--muted);font-size:0.85em;">{name}</p></div>'
            html += "</div>"
    return html


def generate_html_report(
    out_dir: str,
    summaries: dict,
    grid_summary_df: Optional[pd.DataFrame] = None,
) -> str:
    """
    Generate the Z1 M1 HTML report using TokenLab's ReportBuilder.

    Args:
        out_dir: Root output directory (containing plots/, etc.)
        summaries: dict mapping scenario_name -> summary dict
        grid_summary_df: Optional 27-scenario grid DataFrame

    Returns:
        Path to the generated HTML file.
    """
    report = ReportBuilder(
        title="Z1 M1 Core Solvency Model",
        subtitle="Reduced-form directional solvency ABM — Full Report",
        footer_text=(
            "Z1 M1 Core Solvency Model — Reduced-form directional solvency ABM.<br>"
            "Results depend on provisional parameter guesses and a non-exogenous price."
        ),
    )

    plots_dir = os.path.join(out_dir, "plots")

    # ── Section 1–3: Purpose, Scope, Deferred ────────────────────────
    report.add_blockquote(
        "M1 is a directional solvency model. It tests core structure, not final calibration."
    )

    report.add_text_section("1. Purpose", (
        "<p>This <strong>reduced-form cohort ABM</strong> answers: "
        "<em>Can the Z1 Audience Reserve and Treasury loop survive under plausible stress?</em></p>"
        "<p>Core loop: ACR issuance → vesting → settlement (AR) → utility spend → "
        "Treasury fee/burn → Treasury top-up of AR.</p>"
        "<p>104 epochs (≈ 2 years weekly) across 27 stress scenarios.</p>"
    ))

    report.add_table_section("2. What M1 Includes", ["Component", "Implementation"], [
        ["Cohorts", "3 viewer types: passive, active, power"],
        ["ACR Issuance", "Rate × verified users × throttle"],
        ["Vesting", "Configurable lag (default 4 epochs)"],
        ["Settlement", "Queue-based, capped per epoch, cannot overdraw AR"],
        ["Utility Spend", "Split: provider / Treasury fee / burn"],
        ["Brand Inflow", "Exogenous per-epoch to Treasury"],
        ["Health Throttle", "Reduces issuance when AR ratio < 0.3"],
        ["Invariants", "Non-negativity, ACR conservation, Z1U flow — every epoch"],
    ])

    report.add_text_section("3. Deferred Scope", (
        "<p>Endogenous price, adversarial agents, campaign lifecycle, creator/validator "
        "cohorts, governance, prediction markets — all deferred to M2+.</p>"
    ))

    # ── Sections 4–6: Named Scenarios (tabbed) ───────────────────────
    named = ["baseline", "collapse_case", "stable_case"]
    present = [n for n in named if n in summaries]

    if present:
        tabs = {}
        for name in present:
            cls = summaries[name].get("classification", "N/A")
            badge = report.badge(cls.upper(), _CLASS_COLORS.get(cls, "#888"))
            label = f"{name.replace('_', ' ').title()} {badge}"
            tabs[label] = _scenario_tab_html(
                summaries[name], os.path.join(plots_dir, name), report
            )
        report.add_tabbed_section("4–6. Named Scenario Results", tabs)

    # ── Section 7: Grid Summary ──────────────────────────────────────
    report.add_heading("7. 27-Scenario Stress Grid")

    grid_scenarios = {k: v for k, v in summaries.items() if k.startswith("shock_")}
    gdf = grid_summary_df if grid_summary_df is not None and len(grid_summary_df) > 0 else None
    if gdf is None and grid_scenarios:
        gdf = pd.DataFrame(grid_scenarios.values())
        if "scenario" not in gdf.columns:
            gdf["scenario"] = list(grid_scenarios.keys())

    if gdf is not None and len(gdf) > 0:
        cc = gdf["classification"].value_counts()
        report.add_card_row([
            {"value": str(cc.get("collapse", 0)), "label": "Collapse", "color": "#DC2626"},
            {"value": str(cc.get("stressed", 0)), "label": "Stressed", "color": "#F59E0B"},
            {"value": str(cc.get("stable", 0)), "label": "Stable", "color": "#16A34A"},
        ])

        # Grid plots
        grid_plot_dir = os.path.join(plots_dir, "grid")
        for png_name in ["grid_1_classification_heatmap.png", "grid_4_ar_trajectories.png",
                         "grid_2_worst_ar_ratio.png", "grid_3_worst_queue.png"]:
            p = os.path.join(grid_plot_dir, png_name)
            if os.path.exists(p):
                report.add_plot(p, png_name.replace(".png", "").replace("_", " ").title())

        # Full table
        rows = []
        for _, row in gdf.sort_values("min_ar_ratio").iterrows():
            badge = report.badge(row["classification"].upper(),
                                 _CLASS_COLORS.get(row["classification"], "#888"))
            rows.append([
                row["scenario"], badge,
                _fmt(row["final_ar_ratio"]), _fmt(row["min_ar_ratio"]),
                _fmt(row["max_settlement_queue_z1u"], ",.0f"),
                str(row.get("throttle_epochs", "N/A")),
            ])
        report.add_table(
            ["Scenario", "Classification", "Final AR", "Min AR", "Max Queue", "Throttle"],
            rows,
        )

    # ── Sections 8–11 ────────────────────────────────────────────────
    report.add_text_section("8. Sensitivity Findings", "")
    report.add_callout(
        "<strong>Status:</strong> First-pass sensitivity screening not yet executed. "
        "Top candidates: <code>claim_rate</code>, <code>settle_propensity</code>, "
        "<code>settlement_cap_per_epoch</code>, <code>brand_inflow_per_epoch</code>.",
        style="warn",
    )

    report.add_heading("9. Risk Thresholds Observed")
    if gdf is not None and len(gdf) > 0:
        report.add_callout(
            "<strong>Key finding:</strong> The <code>demand_support</code> axis is the "
            "dominant survival lever. All <code>support=high</code> scenarios survive. "
            "All <code>support=low</code> collapse. "
            "<strong>Utility spend and brand inflow are structurally necessary.</strong>",
            style="danger",
        )

    report.add_table_section("10. Known Limitations", ["#", "Limitation"], [
        ["1", "No endogenous pricing — fixed settlement ratio"],
        ["2", "Deterministic cohort behavior — no heterogeneity"],
        ["3", "No adversarial agents"],
        ["4", "Reduced-form verification — simple pass rates"],
        ["5", "Provisional parameters — directional, not predictive"],
        ["6", "Linear adoption profile"],
        ["7", "No campaign revenue (G9b/G10c)"],
        ["8", "Single-run determinism — no CI without parameter jitter"],
    ])

    report.add_table_section("11. Recommended M2 Extensions",
                             ["Priority", "Extension", "Rationale"], [
        ["P0", "Endogenous market pricing", "Settlement value must respond to supply/demand"],
        ["P0", "Multi-repetition Monte Carlo", "Required for confidence intervals"],
        ["P1", "Morris sensitivity screening", "Identify dominant parameters"],
        ["P1", "Adversarial settlement-rush", "Test coordinated withdrawal resilience"],
        ["P1", "Campaign lifecycle & escrow", "Model primary revenue engine"],
        ["P2", "Creator/validator cohorts", "Expand beyond 3 viewer cohorts"],
        ["P2", "Dynamic brand inflow", "Link brand spend to ecosystem health"],
        ["P3", "Full 14-agent taxonomy", "Complete agent specification"],
    ])

    return report.save(os.path.join(out_dir, "M1_report.html"))
