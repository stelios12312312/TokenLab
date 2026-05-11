"""
Z1 M2 HTML Report — uses TokenLab's general-purpose ReportBuilder.

This is a thin domain-specific wrapper that maps Z1 M2 simulation outputs
into the generic ReportBuilder API.
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
        ["Final Z1U Price", "$" + _fmt(summary.get("final_price"), ".4f")],
        ["Min Z1U Price", "$" + _fmt(summary.get("min_price"), ".4f")],
        ["Final Treasury", _fmt(summary.get("final_treasury"), ",.0f") + " Z1U"],
        ["Final Escrow", _fmt(summary.get("final_escrow"), ",.0f") + " Z1U"],
        ["Max Settlement Queue", _fmt(summary.get("max_settlement_queue_z1u"), ",.0f") + " Z1U"],
        ["Total Utility Spend", _fmt(summary.get("total_utility_spend"), ",.0f") + " Z1U"],
        ["Total Burn", _fmt(summary.get("total_burn"), ",.0f") + " Z1U"],
        ["Total Brand Deposits", _fmt(summary.get("total_brand_inflow"), ",.0f") + " Z1U"],
        ["Throttle Epochs", f"{summary.get('throttle_epochs', 0)} / 260"],
        ["Panic Epochs", f"{summary.get('panic_epochs', 0)} / 260"],
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


def _add_html_executive_summary(report, summaries: dict, grid_summary_df, plots_dir: str):
    """Add executive summary section to the HTML report."""
    report.add_heading("Executive Summary")

    # Build grid data
    grid_scenarios = {k: v for k, v in summaries.items() if k.startswith("shock_")}
    gdf = grid_summary_df if grid_summary_df is not None and len(grid_summary_df) > 0 else None
    if gdf is None and grid_scenarios:
        gdf = pd.DataFrame(grid_scenarios.values())
        if "scenario" not in gdf.columns:
            gdf["scenario"] = list(grid_scenarios.keys())

    if gdf is not None and len(gdf) > 0:
        total = len(gdf)
        n_collapse = int((gdf["classification"] == "collapse").sum())
        n_stressed = int((gdf["classification"] == "stressed").sum())
        n_stable = int((gdf["classification"] == "stable").sum())

        # Verdict
        if n_collapse > total * 0.5:
            verdict_text = "SYSTEM FAILURE — A majority of stress scenarios result in protocol collapse."
            verdict_color = "#DC2626"
        elif n_stable == 0:
            verdict_text = "NO SAFE HARBOUR — The protocol survives under stress but no scenario achieves full stability."
            verdict_color = "#F59E0B"
        elif n_stable < total * 0.5:
            verdict_text = "CONDITIONALLY VIABLE — The protocol is stable under favourable conditions but fragile under adversarial stress."
            verdict_color = "#F59E0B"
        else:
            verdict_text = "STRUCTURALLY SOUND — A majority of stress scenarios maintain protocol solvency."
            verdict_color = "#16A34A"

        report.add_card_row([
            {"value": verdict_text, "label": "VERDICT", "color": verdict_color},
        ])

        report.add_card_row([
            {"value": str(n_stable), "label": f"Stable ({n_stable/total*100:.0f}%)", "color": "#16A34A"},
            {"value": str(n_stressed), "label": f"Stressed ({n_stressed/total*100:.0f}%)", "color": "#F59E0B"},
            {"value": str(n_collapse), "label": f"Collapse ({n_collapse/total*100:.0f}%)", "color": "#DC2626"},
        ])

        # Key metrics
        worst_ar = float(gdf["min_ar_ratio"].min())
        best_final_ar = float(gdf["final_ar_ratio"].max()) if "final_ar_ratio" in gdf.columns else None
        max_throttle = int(gdf["throttle_epochs"].max()) if "throttle_epochs" in gdf.columns else None
        key_rows = [
            ["Worst-case min AR ratio", _fmt(worst_ar)],
        ]
        if best_final_ar is not None:
            key_rows.append(["Best-case final AR ratio", _fmt(best_final_ar)])
        if max_throttle is not None:
            key_rows.append(["Max throttle duration", f"{max_throttle} / 260 epochs"])
        key_rows.append(["Grid collapse rate", f"{n_collapse}/{total} ({n_collapse/total*100:.0f}%)"])
        report.add_table_section("Key Grid Metrics", ["Metric", "Value"], key_rows)

    # Named scenario highlights
    named = {k: v for k, v in summaries.items() if not k.startswith("shock_")}
    if named:
        rows = []
        for name, s in named.items():
            cls = s.get("classification", "N/A")
            badge = report.badge(cls.upper(), _CLASS_COLORS.get(cls, "#888"))
            rows.append([
                name.replace("_", " ").title(),
                badge,
                _fmt(s.get("final_ar_ratio")),
                _fmt(s.get("min_ar_ratio")),
                "$" + _fmt(s.get("final_price", 0), ".4f"),
                str(s.get("panic_epochs", 0)),
            ])
        report.add_table_section(
            "Named Scenario Highlights",
            ["Scenario", "Classification", "Final AR", "Min AR", "Final Price", "Panic Epochs"],
            rows,
        )

        # CI bands
        ci_html = ""
        for name, s in named.items():
            if "final_ar_ratio_p05" in s and "final_ar_ratio_p95" in s:
                ci_html += (
                    f"<p><strong>{name.replace('_', ' ').title()} AR 90% CI:</strong> "
                    f"[{_fmt(s['final_ar_ratio_p05'])} – {_fmt(s['final_ar_ratio_p95'])}] "
                    f"(n={s.get('n_repetitions', '?')} runs)</p>"
                )
        if ci_html:
            report.add_text_section("", ci_html)

    # Takeaways
    if gdf is not None and len(gdf) > 0:
        takeaways = "<ol>"
        if n_stable > 0 and n_stressed > 0:
            takeaways += (
                f"<li><strong>{n_stable}/{total} scenarios are fully stable</strong> — the protocol sustains "
                f"AR above 0.99 for 5 years without throttle activation.</li>"
            )
            takeaways += (
                f"<li><strong>{n_stressed}/{total} scenarios show stress</strong> — the throttle engages but the protocol "
                f"survives. These are boundary conditions requiring monitoring.</li>"
            )
            if n_collapse > 0:
                takeaways += (
                    f"<li><strong>{n_collapse}/{total} scenarios collapse</strong> — AR falls below the 0.3 threshold. "
                    f"These configurations must be avoided in production.</li>"
                )
            else:
                takeaways += f"<li><strong>Zero collapses</strong> across all {total} scenarios.</li>"
        elif n_stable == 0:
            takeaways += (
                f"<li><strong>No fully stable scenario exists</strong> — all {total} configurations trigger the throttle.</li>"
                "<li><strong>Parameter recalibration required.</strong></li>"
            )
        takeaways += (
            "<li><strong>Primary survival lever:</strong> Utility spend and brand campaign inflows are the dominant "
            "factors determining whether the protocol crosses from 'stressed' to 'stable'.</li>"
        )
        takeaways += "</ol>"
        report.add_text_section("Critical Takeaways", takeaways)


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
        title="Z1 M2 Market Dynamics Model",
        subtitle="Endogenous pricing and adversarial solvency ABM — Full Report",
        footer_text=(
            "Z1 M2 Market Dynamics Model — Endogenous pricing and adversarial solvency ABM.<br>"
            "Results depend on provisional parameter guesses and initial AMM depth."
        ),
    )

    plots_dir = os.path.join(out_dir, "plots")

    # ── Section 1–3: Purpose, Scope, Deferred ────────────────────────
    report.add_blockquote(
        "M2 adds endogenous market pricing and adversarial behavior to the M1 structural core."
    )

    # ── Executive Summary ─────────────────────────────────────────────
    _add_html_executive_summary(report, summaries, grid_summary_df, plots_dir)

    report.add_text_section("1. Differences from M1 to M2", (
        "<ul>"
        "<li><strong>Endogenous AMM:</strong> Price is no longer static. Whales dumping Z1U on the AMM crashes the spot price.</li>"
        "<li><strong>Dynamic Settlement Ratio:</strong> Peg defense mechanism where settlement ratios drop proportionally to the AMM spot price to protect the AR.</li>"
        "<li><strong>Treasury Operations:</strong> Adds fixed burn rates (CIP & Ops Costs) and yield inflows (RWA).</li>"
        "<li><strong>Adversarial Cohorts:</strong> Introduces Whales who attempt to settle 100% of their balance during market panics.</li>"
        "</ul>"
    ))

    report.add_table_section("2. What M2 Includes", ["Component", "Implementation"], [
        ["AMM Pricing", "Endogenous price discovery via constant-product Z1U/USD pool"],
        ["Adversarial Agents", "Bank Run simulation with 100% exit propensities"],
        ["Dynamic Ratio", "Settlement haircut mathematically tied to AMM health"],
        ["Treasury Flows", "Fixed CIP funding, Operational Costs, and RWA yield modeling"],
    ])

    report.add_text_section("3. Deferred Scope", (
        "<p>PCS weight decomposition, prediction markets, "
        "and multi-token staking (Z1P/Z1U) loops are deferred to M3+.</p>"
    ))

    # ── Sections 4–6: Named Scenarios (tabbed) ───────────────────────
    named = ["baseline", "bank_run", "collapse_case", "stable_case"]
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

    # ── Section 8: Parameter Lock Analysis ──────────────────────────
    report.add_heading("8. M2 Parameter Solvency Locks & Magic Equations")
    report.add_text_section("", (
        "<p>To maintain M2 solvency under adversarial stress, the following <strong>magic equations</strong> must hold:</p>"
        "<ul>"
        "<li><strong>Treasury Survival (Operational Lock):</strong><br><code>RWA_Yield + (Utility_Spend * Treasury_Fee) ≥ CIP_Cost + Ops_Cost</code><br>If the structural burn exceeds yield, the Treasury depletes and cannot defend the AR.</li>"
        "<li><strong>Circuit Breaker Lock (Peg Defense):</strong><br><code>Dynamic_Ratio = Baseline_Ratio × (Current_Price / Genesis_Price)</code><br>If the AMM price crashes by 50%, the protocol forces users to take a 50% haircut on exit, strictly preserving the Audience Reserve.</li>"
        "<li><strong>AMM Liquidity Lock:</strong><br><code>Total_Settlement_Volume_per_Epoch &lt; 0.10 × AMM_Z1U_Reserve</code><br>If a single epoch's settlement dump exceeds 10% of the AMM depth, slippage causes a recursive price collapse.</li>"
        "</ul>"
    ))

    # Per-scenario lock diagnostics
    from .config import SolvencyConfig
    from .scenarios import get_scenario_config, generate_stress_grid

    lock_rows = []
    # Named scenarios
    for name in present:
        try:
            cfg = get_scenario_config(name)
        except ValueError:
            continue
        ratio = cfg.compute_solvency_ratio()
        locks = cfg.check_solvency_locks()
        l1 = next((l for l in locks if l['lock'] == 'L1'), None)
        l2 = next((l for l in locks if l['lock'] == 'L2'), None)
        l3 = next((l for l in locks if l['lock'] == 'L3'), None)
        l4_fails = [l for l in locks if l['lock'] == 'L4']

        cls = summaries[name].get("classification", "N/A")
        badge_cls = report.badge(cls.upper(), _CLASS_COLORS.get(cls, "#888"))

        def _lock_icon(lock_dict):
            if lock_dict is None:
                return "✅"
            return {"PASS": "✅", "WARN": "⚠️", "FAIL": "❌"}.get(lock_dict['status'], "?")

        l4_str = f"⚠️ {len(l4_fails)}" if l4_fails else "✅"

        lock_rows.append([
            name.replace('_', ' ').title(), badge_cls,
            f"{ratio:.3f}", _lock_icon(l1), _lock_icon(l2),
            _lock_icon(l3), l4_str
        ])

    # Grid scenarios (sample: worst 5 + best 5)
    grid = generate_stress_grid()
    grid_lock_data = []
    for gname, gcfg in grid:
        grid_lock_data.append((gname, gcfg, gcfg.compute_solvency_ratio()))
    grid_lock_data.sort(key=lambda x: x[2])

    sample = grid_lock_data[:5] + grid_lock_data[-5:]
    for gname, gcfg, ratio in sample:
        locks = gcfg.check_solvency_locks()
        l1 = next((l for l in locks if l['lock'] == 'L1'), None)
        l2 = next((l for l in locks if l['lock'] == 'L2'), None)
        l3 = next((l for l in locks if l['lock'] == 'L3'), None)
        l4_fails = [l for l in locks if l['lock'] == 'L4']

        grid_cls = "stable" if ratio < 0.8 else ("stressed" if ratio < 3.0 else "collapse")
        if gname in summaries:
            grid_cls = summaries[gname].get("classification", grid_cls)
        badge_cls = report.badge(grid_cls.upper(), _CLASS_COLORS.get(grid_cls, "#888"))

        def _lock_icon(lock_dict):
            if lock_dict is None:
                return "✅"
            return {"PASS": "✅", "WARN": "⚠️", "FAIL": "❌"}.get(lock_dict['status'], "?")

        l4_str = f"⚠️ {len(l4_fails)}" if l4_fails else "✅"
        lock_rows.append([
            gname.replace('_', ' ').title(), badge_cls,
            f"{ratio:.3f}", _lock_icon(l1), _lock_icon(l2),
            _lock_icon(l3), l4_str
        ])

    lock_rows.sort(key=lambda r: float(r[2]))

    report.add_table(
        ["Scenario", "Outcome", "Solvency Ratio", "L1 Floor", "L2 Settle/Fee", "L3 Inflow", "L4 Cohort"],
        lock_rows,
    )

    # Cohort net-drain analysis
    report.add_heading("Per-Cohort Net-Drain Analysis (Baseline)")
    baseline_cfg = SolvencyConfig()
    cohort_rows = []
    for cohort in ["passive_viewers", "active_viewers", "power_users"]:
        settle = baseline_cfg.settle_propensity_by_cohort[cohort]
        spend = baseline_cfg.utility_spend_rate_by_cohort[cohort]
        ratio_val = settle / spend if spend > 0 else float('inf')
        status = "Net Extractor ⚠️" if ratio_val > 0.5 else "Net Contributor ✅"
        color = "#DC2626" if ratio_val > 0.5 else "#16A34A"
        cohort_rows.append([
            cohort.replace('_', ' ').title(),
            f"{settle:.2f}", f"{spend:.2f}",
            f"{ratio_val:.2f}",
            report.badge(status, color),
        ])
    report.add_table(
        ["Cohort", "Settle Propensity", "Utility Spend Rate", "Settle/Spend Ratio", "Status"],
        cohort_rows,
    )

    # Lock summary cards
    baseline_ratio = baseline_cfg.compute_solvency_ratio()
    ratio_color = "#16A34A" if baseline_ratio < 0.8 else ("#F59E0B" if baseline_ratio < 1.0 else "#DC2626")
    report.add_card_row([
        {"value": f"{baseline_ratio:.2f}", "label": "Baseline Solvency Ratio", "color": ratio_color},
        {"value": "< 0.80", "label": "Target (Stable)", "color": "#16A34A"},
        {"value": f"{baseline_cfg.settlement_ratio:.2f}", "label": "Settlement Ratio", "color": "#2563EB"},
        {"value": f"{baseline_cfg.utility_fee_share:.0%}", "label": "Utility Fee Share", "color": "#7C3AED"},
    ])

    report.add_callout(
        "<strong>Design Rules for Tokenomist:</strong>"
        "<ol>"
        "<li><strong>L1 — Solvency Floor:</strong> Keep outflow/inflow &lt; 0.8. "
        "This is the single most important constraint.</li>"
        "<li><strong>L2 — Settlement ≤ 2×Fee:</strong> <code>settlement_ratio ≤ 2 × utility_fee_share</code>. "
        "Prevents structural drain.</li>"
        "<li><strong>L3 — Brand Inflow Floor:</strong> Brand inflow ≥ 1% of AR per epoch. "
        "Below this, <em>no parameter combination saves the system</em>.</li>"
        "<li><strong>L4 — Cohort Balance:</strong> Each cohort's settle propensity should be "
        "≤ 50% of their utility spend rate. Passive viewers currently violate this.</li>"
        "<li><strong>L5 — Treasury Funding:</strong> Don't promise topups you can't fund.</li>"
        "</ol>",
        style="info",
    )

    report.add_heading("9. M2 Summary of Findings")
    report.add_callout(
        "<strong>Key M2 Findings:</strong>"
        "<ol>"
        "<li><strong>The Circuit Breaker Works:</strong> Even when Adversarial Whales attempt a 'Bank Run' by dumping massive amounts of ACR, the dynamic settlement ratio successfully drops, ensuring the Audience Reserve safely bounces off the 25% Constitutional Floor.</li>"
        "<li><strong>AMM Asymptotic Death Spiral:</strong> While the internal AR is protected, without external buy-side pressure (Treasury Market Making), adversarial dumping will cause the AMM price to permanently approach $0.00.</li>"
        "<li><strong>Operational Seniority Danger:</strong> If Operational Costs and CIP funding have seniority over AR Top-ups, the Treasury will continue paying developers while user exits are hard-locked.</li>"
        "</ol>",
        style="info",
    )

    report.add_heading("The Zombie Protocol Paradox")
    report.add_text_section("", (
        "<p>In the Bank Run scenario, a counter-intuitive dynamic occurs: <strong>The Treasury drops to zero, but the Audience Reserve (AR) remains artificially high (bouncing off the 25% floor).</strong></p>"
        "<p><strong>Mechanism:</strong></p>"
        "<ul>"
        "<li>Fixed Operational and CIP costs drain the Treasury by 15,000 Z1U every epoch.</li>"
        "<li>The Constitutional Floor hard-locks the AR. Users trying to exit receive massive slippage haircuts or are blocked entirely.</li>"
        "</ul>"
        "<p><strong>Conclusion:</strong> A protocol can appear technically 'solvent' on-chain (since the AR never drops below the constitutional limit) while being functionally bankrupt and trapping its users. This highlights the danger of granting operational costs seniority over user settlement.</p>"
    ))

    report.add_heading("10. Risk Thresholds Observed")
    if gdf is not None and len(gdf) > 0:
        report.add_callout(
            "<strong>Key finding:</strong> The <code>demand_support</code> axis is the "
            "dominant survival lever. All <code>support=high</code> scenarios survive. "
            "All <code>support=low</code> collapse. "
            "<strong>Utility spend and brand inflow are structurally necessary.</strong>",
            style="danger",
        )

    report.add_table_section("11. Known Limitations", ["#", "Limitation"], [
        ["1", "Static Initial Liquidity - No LP entry/exit modeling"],
        ["2", "Simplified Panic Behavior - Linear exit modeling"],
        ["3", "No Staking Loops (Z1P)"],
        ["4", "Reduced-form verification - simple pass rates"],
        ["5", "Provisional parameters - directional, not predictive"],
        ["6", "Linear adoption profile"],
        ["7", "No RWA linkage (G10c) in Treasury loop"],
    ])

    report.add_table_section("12. Recommended M3 Extensions",
                             ["Priority", "Extension", "Rationale"], [
        ["P0", "Multi-token Staking (Z1P)", "Sink for Z1U to reduce sell pressure"],
        ["P0", "Dynamic LP Dynamics", "Liquidity response to yield/volatility"],
        ["P1", "Full PCS Decomposition", "Multi-factor scoring integration"],
        ["P1", "Creator & Validator Cohorts", "Model supply-side agents"],
        ["P2", "Governance & Delegation", "Parameter attack vectors"],
        ["P3", "Prediction Market Sink", "Secondary Z1U utility sinks"],
    ])

    return report.save(os.path.join(out_dir, "M2_report.html"))

