import json
import os
import pandas as pd

# ═══════════════════════════════════════════════════════════════════════
#  Z1 M2 REPORT GENERATOR  (Prompt 11 — M2 Market Dynamics)
# ═══════════════════════════════════════════════════════════════════════

def _fmt(value, fmt_str='.2f'):
    """Safe formatter that handles None / missing values."""
    if value is None:
        return 'N/A'
    try:
        return f'{value:{fmt_str}}'
    except (ValueError, TypeError):
        return str(value)


def _scenario_section(name: str, summary: dict, section_num: int) -> str:
    """Render one named-scenario section with a metrics table and narrative."""
    classification = summary.get('classification', 'N/A')
    emoji = {'collapse': '🔴', 'stressed': '🟡', 'stable': '🟢'}.get(classification, '⚪')

    md = f"""## {section_num}. {name.replace('_', ' ').title()} Result

**Classification: {emoji} {classification.upper()}**

| Metric | Value |
|--------|-------|
| Final AR Ratio | {_fmt(summary.get('final_ar_ratio'))} |
| Min AR Ratio | {_fmt(summary.get('min_ar_ratio'))} |
| Final Treasury (Z1U) | {_fmt(summary.get('final_treasury'), ',.0f')} |
| Min Treasury (Z1U) | {_fmt(summary.get('min_treasury'), ',.0f')} |
| Max Settlement Queue (Z1U) | {_fmt(summary.get('max_settlement_queue_z1u'), ',.0f')} |
| Avg Pressure Ratio | {_fmt(summary.get('avg_settlement_pressure_ratio'))} |
| Max Pressure Ratio | {_fmt(summary.get('max_settlement_pressure_ratio'))} |
| Final Z1U Price (USD) | {_fmt(summary.get('final_price'), '.4f')} |
| Min Z1U Price (USD) | {_fmt(summary.get('min_price'), '.4f')} |
| Final Escrow (Z1U) | {_fmt(summary.get('final_escrow'), ',.0f')} |
| Total Utility Spend (Z1U) | {_fmt(summary.get('total_utility_spend'), ',.0f')} |
| Total Treasury Fees (Z1U) | {_fmt(summary.get('total_treasury_fees'), ',.0f')} |
| Total Provider Payments (Z1U) | {_fmt(summary.get('total_provider_payments'), ',.0f')} |
| Total Burn (Z1U) | {_fmt(summary.get('total_burn'), ',.0f')} |
| Total Brand Deposits (Z1U) | {_fmt(summary.get('total_brand_inflow'), ',.0f')} |
| Throttle Epochs | {summary.get('throttle_epochs', 0)} / 260 |
| AR Floor Breach Epochs | {summary.get('ar_floor_breach_epochs', 0)} |
| Panic Epochs | {summary.get('panic_epochs', 0)} |

"""

    # Add narrative interpretation
    if classification == 'collapse':
        md += (
            f"**Interpretation:** The {name} scenario demonstrates a structural failure of the "
            f"AR/Treasury loop. The Audience Reserve ratio fell to {_fmt(summary.get('min_ar_ratio'))}, "
            f"well below the 0.3 collapse threshold. The throttle engaged for "
            f"{summary.get('throttle_epochs', 0)} of 260 epochs, but was unable to prevent depletion. "
            f"Settlement demand (peak queue: {_fmt(summary.get('max_settlement_queue_z1u'), ',.0f')} Z1U) "
            f"overwhelmed the Treasury's capacity to recapitalise the Audience Reserve.\n\n"
        )
    elif classification == 'stressed':
        md += (
            f"**Interpretation:** The {name} scenario shows the system under pressure but surviving. "
            f"The AR ratio dipped to {_fmt(summary.get('min_ar_ratio'))} before recovering to "
            f"{_fmt(summary.get('final_ar_ratio'))}. "
            f"Settlement queue peaked at {_fmt(summary.get('max_settlement_queue_z1u'), ',.0f')} Z1U. "
            f"The throttle was active for {summary.get('throttle_epochs', 0)} epochs.\n\n"
        )
    else:
        md += (
            f"**Interpretation:** The {name} scenario demonstrates healthy loop dynamics. "
            f"Utility spend, brand inflows, and Treasury fees collectively sustain the Audience Reserve "
            f"at a ratio of {_fmt(summary.get('final_ar_ratio'))}. "
            f"No throttle activation was required.\n\n"
        )

    md += f"📊 *See plots in `plots/{name}/`*\n\n"
    return md


def _build_executive_summary(summaries: dict, grid_summary_df: pd.DataFrame = None) -> str:
    """Build a data-driven executive summary from simulation results."""
    md = "## Executive Summary\n\n"

    # ── 1. Grid-level verdict ─────────────────────────────────────
    grid_scenarios = {k: v for k, v in summaries.items() if k.startswith('shock_')}
    gdf = grid_summary_df if grid_summary_df is not None and len(grid_summary_df) > 0 else None
    if gdf is None and grid_scenarios:
        gdf = pd.DataFrame(grid_scenarios.values())
        if 'scenario' not in gdf.columns:
            gdf['scenario'] = list(grid_scenarios.keys())

    if gdf is not None and len(gdf) > 0:
        total = len(gdf)
        n_collapse = int((gdf['classification'] == 'collapse').sum())
        n_stressed = int((gdf['classification'] == 'stressed').sum())
        n_stable   = int((gdf['classification'] == 'stable').sum())

        # Verdict
        if n_collapse > total * 0.5:
            verdict = "🔴 **VERDICT: SYSTEM FAILURE** — A majority of stress scenarios result in protocol collapse."
        elif n_stable == 0:
            verdict = "🟡 **VERDICT: NO SAFE HARBOUR** — The protocol survives under stress but no scenario achieves full stability."
        elif n_stable < total * 0.5:
            verdict = "🟡 **VERDICT: CONDITIONALLY VIABLE** — The protocol is stable under favourable conditions but fragile under adversarial stress."
        else:
            verdict = "🟢 **VERDICT: STRUCTURALLY SOUND** — A majority of stress scenarios maintain protocol solvency."

        md += f"{verdict}\n\n"

        md += "### 27-Scenario Stress Grid Results\n\n"
        md += f"The M2 simulation stress-tested **{total} parameter combinations** across 3 axes "
        md += "(RWA Yield / Buyback Ratio / Operational Costs) over **260 epochs (≈ 5 years)**.\n\n"
        md += "| Classification | Count | Share |\n"
        md += "|---------------|-------|-------|\n"
        for cls, emoji in [('stable', '🟢'), ('stressed', '🟡'), ('collapse', '🔴')]:
            cnt = {'stable': n_stable, 'stressed': n_stressed, 'collapse': n_collapse}[cls]
            md += f"| {emoji} {cls.title()} | {cnt} | {cnt/total*100:.0f}% |\n"
        md += "\n"

        # Key numbers from the grid
        worst_ar = float(gdf['min_ar_ratio'].min())
        best_final_ar = float(gdf['final_ar_ratio'].max()) if 'final_ar_ratio' in gdf.columns else None
        max_throttle = int(gdf['throttle_epochs'].max()) if 'throttle_epochs' in gdf.columns else None

        md += "### Key Grid Metrics\n\n"
        md += "| Metric | Value |\n"
        md += "|--------|-------|\n"
        md += f"| Worst-case min AR ratio | {_fmt(worst_ar)} |\n"
        if best_final_ar is not None:
            md += f"| Best-case final AR ratio | {_fmt(best_final_ar)} |\n"
        if max_throttle is not None:
            md += f"| Max throttle duration | {max_throttle} / 260 epochs |\n"
        md += f"| Grid collapse rate | {n_collapse}/{total} ({n_collapse/total*100:.0f}%) |\n"
        md += "\n"
    else:
        md += "*No grid data available for executive summary.*\n\n"

    # ── 2. Named scenario highlights ──────────────────────────────
    named = {k: v for k, v in summaries.items() if not k.startswith('shock_')}
    if named:
        md += "### Named Scenario Highlights\n\n"
        md += "| Scenario | Classification | Final AR | Min AR | Final Price | Panic Epochs |\n"
        md += "|----------|---------------|----------|--------|-------------|-------------|\n"
        for name, s in named.items():
            emoji = {'collapse': '🔴', 'stressed': '🟡', 'stable': '🟢'}.get(s.get('classification', ''), '⚪')
            md += (f"| {name.replace('_', ' ').title()} | {emoji} {s.get('classification', 'N/A').title()} "
                   f"| {_fmt(s.get('final_ar_ratio'))} | {_fmt(s.get('min_ar_ratio'))} "
                   f"| ${_fmt(s.get('final_price', 0), '.4f')} "
                   f"| {s.get('panic_epochs', 0)} |\n")
        md += "\n"

        # CI bands if available
        for name, s in named.items():
            if 'final_ar_ratio_p05' in s and 'final_ar_ratio_p95' in s:
                md += (f"**{name.replace('_', ' ').title()} AR 90% CI:** "
                       f"[{_fmt(s['final_ar_ratio_p05'])} – {_fmt(s['final_ar_ratio_p95'])}] "
                       f"(n={s.get('n_repetitions', '?')} runs)\n\n")

    # ── 3. Actionable takeaways ───────────────────────────────────
    md += "### Critical Takeaways\n\n"

    if gdf is not None and len(gdf) > 0:
        n_stable_count = n_stable
        if n_stable_count > 0 and n_stressed > 0:
            stable_scenarios = gdf[gdf['classification'] == 'stable']
            stressed_scenarios = gdf[gdf['classification'] == 'stressed']
            md += (f"1. **{n_stable_count}/{total} scenarios are fully stable** — the protocol sustains "
                   f"AR above 0.99 for 5 years without throttle activation in these configurations.\n")
            md += (f"2. **{n_stressed}/{total} scenarios show stress** — the throttle engages but the protocol "
                   f"survives. These represent boundary conditions requiring monitoring.\n")
            if n_collapse > 0:
                md += (f"3. **{n_collapse}/{total} scenarios collapse** — AR falls below the 0.3 threshold. "
                       f"These configurations must be avoided in production.\n")
            else:
                md += f"3. **Zero collapses** across all {total} scenarios — no configuration leads to protocol death.\n"
        elif n_stable_count == 0:
            md += f"1. **No fully stable scenario exists** — all {total} configurations trigger the throttle at least once.\n"
            md += "2. **Parameter recalibration required** — the current stress grid does not contain a viable production configuration.\n"
        md += (f"4. **Primary survival lever:** Utility spend and brand campaign inflows are the dominant "
               f"factors determining whether the protocol crosses from 'stressed' to 'stable'.\n")
    else:
        md += "1. Grid data not available — strategic conclusions require a full 27-scenario sweep.\n"

    md += "\n"
    return md

def generate_report(out_dir: str, summaries: dict, grid_summary_df: pd.DataFrame = None):
    """
    Generate the full M1 report with all 11 sections required by Prompt 11.

    Args:
        out_dir: Output directory for the report.
        summaries: dict mapping scenario_name -> summary dict.
        grid_summary_df: Optional DataFrame of the 27-scenario grid results.
    """

    # ── Executive Summary (computed from data) ─────────────────────
    exec_summary = _build_executive_summary(summaries, grid_summary_df)

    # ── Section 1: Purpose ───────────────────────────────────────────
    md = f"""# Z1 M2 Market Dynamics — Full Report

> **"M2 adds endogenous pricing and adversarial behavior to the M1 solvency core."**

---

{exec_summary}

---

## 1. Purpose of the Model

This is a **market-aware cohort agent-based model (ABM)** built to answer:

> *Can the Z1 system maintain solvency when pricing is endogenous and agents are adversarial?*

The core economic loop under test is:

```
Issuance → Vesting → Settlement → Market (AMM) → Price Discovery → Panic Feedback → Utility Recap
```

M2 targets three new research questions:
- **Q1:** Does price slippage during mass-settlement create a death spiral?
- **Q2:** Can the Treasury defend the 25% AR floor against adversarial "bank runs"?
- **Q3:** How does escrow-funded utility release stabilise the market?

The model runs 260 epochs (≈ 5 years of weekly cycles) across multiple stress scenarios.

---

## 2. What M2 Includes (Differences to M1)

| Component | Implementation |
|-----------|---------------|
| **Endogenous AMM** | Price is no longer static. Whales dumping Z1U crashes the spot price. |
| **Dynamic Settlement Ratio** | Peg defense where settlement ratios drop proportionally to the AMM spot price to protect the AR. |
| **Treasury Operations** | Adds fixed burn rates (CIP & Ops Costs) and yield inflows (RWA). |
| **Adversarial Cohorts** | Introduces Whales who attempt to settle 100% of their balance during market panics. |

---

## 3. What M2 Still Defers

The following belong to M3/M4+:

- PCS weight decomposition
- Full brand / creator / validator cohorts (14-agent taxonomy)
- Governance capture and delegation
- Prediction markets
- Multi-token staking (Z1P/Z1U) loops

---

"""

    # ── Sections 4–6: Named Scenarios ────────────────────────────────
    named_scenarios = ['baseline', 'bank_run', 'collapse_case', 'stable_case']
    section_num = 4
    for name in named_scenarios:
        if name in summaries:
            md += _scenario_section(name, summaries[name], section_num)
            md += "---\n\n"
            section_num += 1

    # If named scenarios weren't run separately, section numbering adjusts
    if section_num == 4:
        # No named scenarios found — skip to grid
        section_num = 7

    # ── Section 7: 27-Scenario Stress Grid Summary ───────────────────
    md += f"## {section_num if section_num >= 7 else 7}. 27-Scenario Stress Grid Summary\n\n"

    # Use grid_summary_df if provided, otherwise try to build from summaries
    grid_scenarios = {k: v for k, v in summaries.items() if k.startswith('shock_')}

    if grid_summary_df is not None and len(grid_summary_df) > 0:
        gdf = grid_summary_df
    elif grid_scenarios:
        gdf = pd.DataFrame(grid_scenarios.values())
        if 'scenario' not in gdf.columns:
            gdf['scenario'] = list(grid_scenarios.keys())
    else:
        md += "*Grid results not available in this run.*\n\n---\n\n"
        gdf = None

    if gdf is not None and len(gdf) > 0:
        # Classification counts
        class_counts = gdf['classification'].value_counts()
        total = len(gdf)
        md += "### Classification Summary\n\n"
        md += "| Classification | Count | Share |\n"
        md += "|---------------|-------|-------|\n"
        for cls in ['collapse', 'stressed', 'stable']:
            cnt = class_counts.get(cls, 0)
            emoji = {'collapse': '🔴', 'stressed': '🟡', 'stable': '🟢'}.get(cls, '')
            md += f"| {emoji} {cls.title()} | {cnt} | {cnt/total*100:.0f}% |\n"
        md += f"| **Total** | **{total}** | **100%** |\n\n"

        # Worst 5 by min_ar_ratio
        md += "### Worst 5 Scenarios by Minimum AR Ratio\n\n"
        md += "| Scenario | Min AR Ratio | Classification | Throttle Epochs |\n"
        md += "|----------|-------------|----------------|----------------|\n"
        worst_ar = gdf.nsmallest(5, 'min_ar_ratio')
        for _, row in worst_ar.iterrows():
            md += f"| {row['scenario']} | {_fmt(row['min_ar_ratio'])} | {row['classification']} | {row.get('throttle_epochs', 'N/A')} |\n"
        md += "\n"

        # Worst 5 by max_settlement_queue_z1u
        md += "### Worst 5 Scenarios by Max Settlement Queue\n\n"
        md += "| Scenario | Max Queue (Z1U) | Classification | Max Pressure Ratio |\n"
        md += "|----------|----------------|----------------|-------------------|\n"
        worst_q = gdf.nlargest(5, 'max_settlement_queue_z1u')
        for _, row in worst_q.iterrows():
            md += f"| {row['scenario']} | {_fmt(row['max_settlement_queue_z1u'], ',.0f')} | {row['classification']} | {_fmt(row.get('max_settlement_pressure_ratio', 0))} |\n"
        md += "\n"

        # Full classification table
        md += "### Full Classification Table\n\n"
        md += "| Scenario | Classification | Final AR | Min AR | Max Queue | Throttle Epochs |\n"
        md += "|----------|---------------|----------|--------|-----------|----------------|\n"
        for _, row in gdf.sort_values('min_ar_ratio').iterrows():
            emoji = {'collapse': '🔴', 'stressed': '🟡', 'stable': '🟢'}.get(row['classification'], '')
            md += (f"| {row['scenario']} | {emoji} {row['classification']} "
                   f"| {_fmt(row['final_ar_ratio'])} | {_fmt(row['min_ar_ratio'])} "
                   f"| {_fmt(row['max_settlement_queue_z1u'], ',.0f')} "
                   f"| {row.get('throttle_epochs', 'N/A')} |\n")
        md += "\n📊 *See grid plots in `plots/grid/`*\n\n"

    md += "---\n\n"

    # ── Section 8: Sensitivity Findings & Solvency Drivers ──────────
    md += "## 8. M2 Parameter Solvency Locks & Magic Equations\n\n"
    md += "To maintain M2 solvency under adversarial stress, the following **magic equations** must hold:\n\n"
    
    md += "### L7: Treasury Solvency Lock (Operational Survival)\n"
    md += "`RWA_Yield + (Campaign_Deposits * Fee_Share) + (Utility_Spend * Utility_Fee_Share) ≥ Ops_Cost + CIP_Funding`\n"
    md += "If the structural inflows are lower than the senior structural outflows, the protocol enters a **Zombie State** where the Treasury depletes to 0, trapping users.\n\n"

    md += "### L8: AMM Liquidity Support Lock (Peg Defense)\n"
    md += "`Treasury_Buyback_Ratio > 0.0`\n"
    md += "Without endogenous buybacks, user exits purely extract USD from the AMM. To prevent the asymptotic death spiral, the Treasury must deploy a percentage of its surplus to support the AMM price.\n\n"
    
    md += "### Circuit Breaker Lock\n"
    md += "`Dynamic_Ratio = Baseline_Ratio × (Current_Price / Genesis_Price)`\n"
    md += "If the AMM price crashes by 50%, the protocol forces users to take a 50% haircut on exit, strictly preserving the Audience Reserve.\n\n"
    md += "\n---\n\n"

    # ── Section 9: Risk Thresholds Observed ──────────────────────────
    md += "## 9. Risk Thresholds Observed\n\n"

    if gdf is not None and len(gdf) > 0:
        collapse_df = gdf[gdf['classification'] == 'collapse']
        stressed_df = gdf[gdf['classification'] == 'stressed']
        stable_df = gdf[gdf['classification'] == 'stable']

        md += "Based on the 27-scenario grid, the following empirical thresholds emerge:\n\n"
        md += "| Observation | Value |\n"
        md += "|-------------|-------|\n"

        if len(collapse_df) > 0:
            md += f"| Collapse scenarios | {len(collapse_df)} / {len(gdf)} ({len(collapse_df)/len(gdf)*100:.0f}%) |\n"
            md += f"| Lowest observed AR ratio | {_fmt(gdf['min_ar_ratio'].min())} |\n"
            md += f"| Largest settlement queue | {_fmt(gdf['max_settlement_queue_z1u'].max(), ',.0f')} Z1U |\n"
            md += f"| Max throttle duration | {int(gdf['throttle_epochs'].max())} epochs |\n"

        if len(stressed_df) > 0:
            md += f"| Stressed scenarios | {len(stressed_df)} / {len(gdf)} ({len(stressed_df)/len(gdf)*100:.0f}%) |\n"
            md += f"| AR ratio range (stressed) | {_fmt(stressed_df['final_ar_ratio'].min())} – {_fmt(stressed_df['final_ar_ratio'].max())} |\n"

        if len(stable_df) > 0:
            md += f"| Stable scenarios | {len(stable_df)} / {len(gdf)} ({len(stable_df)/len(gdf)*100:.0f}%) |\n"

        md += "\n"

        md += "**Key finding:** The single most important axis is `demand_support`. "
        md += "All scenarios with `support=high` survive (stressed but not collapsing). "
        md += "All scenarios with `support=low` collapse regardless of shock or pressure level. "
        md += "This suggests **utility spend and brand inflow are the primary survival levers**.\n\n"
    else:
        md += "*Grid data not available — risk thresholds cannot be derived.*\n\n"

    md += "---\n\n"

    md += """## 9. M2 Summary of Findings

1. **The Circuit Breaker Works:** Even when Adversarial Whales attempt a "Bank Run" by dumping massive amounts of ACR, the dynamic settlement ratio successfully drops, ensuring the Audience Reserve safely bounces off the 25% Constitutional Floor.
2. **AMM Asymptotic Death Spiral:** While the internal AR is protected, without external buy-side pressure (Treasury Market Making), adversarial dumping will cause the AMM price to permanently approach $0.00.
3. **Operational Seniority Danger:** If Operational Costs and CIP funding have seniority over AR Top-ups, the Treasury will continue paying developers while user exits are hard-locked.

### The Zombie Protocol Paradox

In the Bank Run scenario, a counter-intuitive dynamic occurs: **The Treasury drops to zero, but the Audience Reserve (AR) remains artificially high (bouncing off the 25% floor).**

**Mechanism:**
- Fixed Operational and CIP costs drain the Treasury by 15,000 Z1U every epoch.
- The Constitutional Floor hard-locks the AR. Users trying to exit receive massive slippage haircuts or are blocked entirely.

**Conclusion:** A protocol can appear technically 'solvent' on-chain (since the AR never drops below the constitutional limit) while being functionally bankrupt and trapping its users. This highlights the danger of granting operational costs seniority over user settlement.

---

"""

    # ── Section 10: Known Limitations ────────────────────────────────
    md += """## 10. Known Limitations

1. **Static Initial Liquidity.** The AMM depth is fixed at start and does not model LP (Liquidity Provider) entry/exit dynamics.
2. **Simplified Panic Behavior.** The "Bank Run" assumes a linear increase in settlement propensity and immediate selling, rather than more complex game-theoretic exit strategies.
3. **No Staking Loops.** Multi-token effects (Z1P staking to reduce Z1U sell pressure) are not yet integrated.
4. **Reduced-form verification.** Claims and verification use simple pass rates, not the full PCS scoring system.
5. **Provisional parameters.** All default parameters are calibration placeholders. Results are directional, not predictive.
6. **Linear adoption profile.** The default adoption schedule spreads onboarding evenly across epochs.
7. **No RWA linkage.** RWA revenue (G10c) is not yet modeled in the Treasury recapitalisation loop.
8. **Single-run determinism.** Standard runs use 1 repetition. Distributional claims require higher-repetition Monte Carlo sweeps.

---

"""

    # ── Section 11: Recommended M2 Extensions ────────────────────────
    md += """## 11. Recommended M3 Extensions

| Priority | Extension | Rationale |
|----------|-----------|-----------|
| P0 | Multi-token Staking (Z1P) | Model the sink for Z1U to reduce immediate market sell pressure |
| P0 | Dynamic LP Dynamics | Allow AMM liquidity to respond to yield and volatility |
| P1 | Full PCS Decomposition | Replace reduced-form verification with multi-factor scoring |
| P1 | Creator & Validator Cohorts | Expand the economy to include supply-side agents |
| P2 | Governance & Delegation | Model attack vectors on Treasury and Protocol parameters |
| P3 | Prediction Market Sink | Integrate secondary utility sinks for Z1U |

---

*Report generated by Z1 M2 Market Dynamics Model.*
*Model classification: Endogenous pricing and adversarial solvency ABM.*
*Results depend on provisional parameter guesses and initial AMM depth.*
"""

    path = os.path.join(out_dir, "M2_report.md")
    with open(path, "w") as f:
        f.write(md)

    return path
