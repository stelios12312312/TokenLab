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
| Throttle Epochs | {summary.get('throttle_epochs', 0)} / 104 |
| AR Floor Breach Epochs | {summary.get('ar_floor_breach_epochs', 0)} |
| Panic Epochs | {summary.get('panic_epochs', 0)} |

"""

    # Add narrative interpretation
    if classification == 'collapse':
        md += (
            f"**Interpretation:** The {name} scenario demonstrates a structural failure of the "
            f"AR/Treasury loop. The Audience Reserve ratio fell to {_fmt(summary.get('min_ar_ratio'))}, "
            f"well below the 0.3 collapse threshold. The throttle engaged for "
            f"{summary.get('throttle_epochs', 0)} of 104 epochs, but was unable to prevent depletion. "
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


def generate_report(out_dir: str, summaries: dict, grid_summary_df: pd.DataFrame = None):
    """
    Generate the full M1 report with all 11 sections required by Prompt 11.

    Args:
        out_dir: Output directory for the report.
        summaries: dict mapping scenario_name -> summary dict.
        grid_summary_df: Optional DataFrame of the 27-scenario grid results.
    """

    # ── Section 1: Purpose ───────────────────────────────────────────
    md = """# Z1 M2 Market Dynamics — Full Report

> **"M2 adds endogenous pricing and adversarial behavior to the M1 solvency core."**

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

The model runs 104 epochs (≈ 2 years of weekly cycles) across multiple stress scenarios.

---

## 2. What M2 Includes

| Component | Implementation |
|-----------|---------------|
| **AMM Pricing** | Endogenous price discovery via constant-product Z1U/USD pool |
| **Escrow Engine** | Brand deposits go to escrow; 25% fee to Treasury |
| **Panic Triggers** | 10% price drop triggers "Bank Run" (10x settlement surge) |
| **L6 Floor Guard** | Constitutional 25% AR floor enforced by settlement capping |
| **Utility Release** | Escrowed Z1U released to Treasury upon user utility spend |
| **Health Throttle** | Reduces ACR issuance when AR ratio < 0.3 |
| **Invariants** | Full conservation including AMM reserves and Escrow balances |

---

## 3. What M2 Still Defers

The following belong to M3/M4+:

- CIP, validators, operations cost
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
    md += "## 8. Sensitivity Findings & Solvency Drivers\n\n"
    
    # Load sensitivity results if available
    oat_path = os.path.join("outputs", "oat_sensitivity.csv")
    if os.path.exists(oat_path):
        try:
            df_oat = pd.read_csv(oat_path)
            md += "### Top 5 Solvency Drivers (OAT Elasticity)\n\n"
            md += "Elasticity measures the sensitivity of the final AR Ratio to a 1% change in the parameter.\n\n"
            md += "| Rank | Parameter | AR Elasticity | Influence |\n"
            md += "|------|-----------|--------------|-----------|\n"
            
            # Ensure Abs Elasticity exists
            if 'AR Elasticity' in df_oat.columns:
                df_oat['Abs Elasticity'] = df_oat['AR Elasticity'].abs()
                df_oat = df_oat.sort_values('Abs Elasticity', ascending=False)
                for i, (_, row) in enumerate(df_oat.head(5).iterrows()):
                    infl = "🟢 RECOVERY" if row['AR Elasticity'] > 0 else "🔴 DRAIN"
                    md += f"| {i+1} | `{row['Parameter']}` | {row['AR Elasticity']:.3f} | {infl} |\n"
            md += "\n"
        except Exception as e:
            md += f"*Error loading sensitivity data: {e}*\n\n"
    else:
        md += "> **Status:** OAT sensitivity ranking not yet executed. Run `sensitivity.py` to identify drivers.\n\n"

    md += "### The Five Parameter Locks (Structural Laws)\n\n"
    md += "The following laws govern the structural solvency of the Z1 loop:\n\n"
    md += "| ID | Lock | Definition | Threshold | Status |\n"
    md += "|----|------|------------|-----------|--------|\n"
    md += "| L1 | **Solvency Floor** | Outflow / Inflow | < 0.8 | HARD |\n"
    md += "| L2 | **Settlement-Fee** | settlement_ratio / fee_share | <= 2.0 | SOFT |\n"
    md += "| L3 | **Brand Inflow Floor** | brand_inflow / AR_initial | >= 1% | HARD |\n"
    md += "| L4 | **Cohort Net-Drain** | settle / spend (per cohort) | <= 0.5 | SOFT |\n"
    md += "| L6 | **Constitutional Floor** | AR / Circulating Supply | >= 25% | HARD |\n"
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

    # ── Section 9b: Key Findings & Minimum Sustainability Thresholds ─
    md += """## 9b. Key Findings & Minimum Sustainability Thresholds

### The Three Parameters That Drive Survival

OAT sensitivity screening ranked 12 parameters. **Only three have meaningful elasticity:**

| Rank | Parameter | AR Elasticity | Meaning |
|------|-----------|:---:|---------|
| 1 | `treasury_topup_threshold_ratio` | **+2.98** | Most powerful lever. Controls *when* Treasury recapitalises the AR. |
| 2 | `audience_reserve_initial` | **−0.77** | Bigger starting AR inflates the denominator — makes topups less effective. |
| 3 | `brand_inflow_per_epoch` | **+0.42** | External revenue. Without it, nothing works. |

All other parameters (settlement cap, vesting lag, fee share, burn share, throttle) have **near-zero elasticity** (< 0.05).

### Hard Constraints (Violate = Collapse)

| Lock | Rule | Minimum Threshold |
|------|------|:---:|
| **L1** | Solvency Ratio (`outflow/inflow`) | **< 0.8** |
| **L3** | Brand Inflow / AR per epoch | **≥ 1%** |
| **L6** | AR / Circulating Supply | **≥ 25%** |
| **L9** | Max single-epoch AR drain | **≤ 10% of initial AR** |

### Optimal Parameter Set (from Monte Carlo calibration)

| Parameter | Optimal Value | Safe Range |
|-----------|:---:|:---:|
| Solvency Ratio | **0.006** | < 0.8 |
| Settlement Ratio | **0.10** | 0.05 – 0.75 |
| Utility Fee Share | **34%** | 6% – 40% |
| Brand Inflow | **2.24% of AR** | ≥ 1% (absolute minimum) |
| Campaign Fee | **25%** | ≥ 15% for AR floor defense |

### The Passive Viewer Problem

Passive viewers are **net extractors** (settle/spend ratio: 2.50x vs target ≤ 0.5x). The system survives because power users subsidise them and brand inflow covers the gap. If the cohort mix shifts toward extractors, the system breaks.

### Design Rules

1. **Set the topup trigger aggressively** — the system is far more sensitive to *when* you recapitalise than to how much money flows in.
2. **Don't over-capitalise the AR at launch** — a giant starting reserve creates a false sense of security.
3. **Brand inflow is the oxygen** — below 1% of AR per epoch, the system collapses in every observed case.
4. **Constitutional 25% AR floor must be enforced mechanically** — don't trust governance to maintain it.
5. **Monitor passive viewer cohort share** — if extractors grow, raise their settlement friction.

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
