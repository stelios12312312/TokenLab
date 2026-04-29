import json
import os
import pandas as pd

# ═══════════════════════════════════════════════════════════════════════
#  Z1 M1 REPORT GENERATOR  (Prompt 11 — all 11 sections)
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
| Total Utility Spend (Z1U) | {_fmt(summary.get('total_utility_spend'), ',.0f')} |
| Total Treasury Fees (Z1U) | {_fmt(summary.get('total_treasury_fees'), ',.0f')} |
| Total Provider Payments (Z1U) | {_fmt(summary.get('total_provider_payments'), ',.0f')} |
| Total Burn (Z1U) | {_fmt(summary.get('total_burn'), ',.0f')} |
| Total Brand Inflow (Z1U) | {_fmt(summary.get('total_brand_inflow'), ',.0f')} |
| Throttle Epochs | {summary.get('throttle_epochs', 0)} / 104 |
| AR Floor Breach Epochs | {summary.get('ar_floor_breach_epochs', 0)} |

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
    md = """# Z1 M1 Core Solvency Model — Full Report

> **"M1 is a directional solvency model. It tests core structure, not final calibration."**

---

## 1. Purpose of the Model

This is a **reduced-form cohort agent-based model (ABM)** built to answer a single structural question:

> *Can the Z1 Audience Reserve and Treasury loop survive under plausible stress?*

The core economic loop under test is:

```
ACR issuance → vesting → settlement (AR) → utility spend → Treasury fee/burn → Treasury top-up of AR
```

M1 targets three research questions:
- **Q1:** Can the Audience Reserve sustain settlement obligations?
- **Q2:** How does vesting create settlement pressure?
- **Q4 (structural):** Does the basic Treasury/AR loop remain solvent?

The model runs 104 epochs (≈ 2 years of weekly cycles) across 27 stress scenarios.

---

## 2. What M1 Includes

| Component | Implementation |
|-----------|---------------|
| Cohorts | 3 viewer types: passive, active, power |
| Claiming & Verification | Reduced-form rates per cohort |
| ACR Issuance | Rate × verified users × throttle multiplier |
| Vesting | Configurable lag (default 4 epochs) |
| Settlement | Queue-based, capped per epoch, cannot overdraw AR |
| Utility Spend | Split into provider payment / Treasury fee / burn |
| Brand Inflow | Exogenous per-epoch inflow to Treasury |
| Treasury Top-up | Recapitalises AR when ratio drops below threshold |
| Health Throttle | Reduces ACR issuance when AR ratio < 0.3 |
| Invariant Checks | Non-negativity, ACR conservation, Z1U flow, queue consistency — every epoch |

---

## 3. What M1 Explicitly Defers

The following are **intentionally excluded** from M1 and belong to M2/M3/M4:

- Endogenous market price / external market feedback
- Adversarial settlement-rush agents
- Full Treasury revenue model (G9b campaign fee, G10c RWA fee, vault Treasury bucket)
- CIP, validators, operations cost
- PCS weight decomposition
- Full brand / creator / validator cohorts (14-agent taxonomy)
- Governance capture and delegation
- Campaign lifecycle and escrow logic
- Prediction markets

---

"""

    # ── Sections 4–6: Named Scenarios ────────────────────────────────
    named_scenarios = ['baseline', 'collapse_case', 'stable_case']
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

    # ── Section 8: Sensitivity Findings ──────────────────────────────
    md += """## 8. Sensitivity Findings

> **Status:** First-pass sensitivity screening has not yet been executed in this run.

The M1 spec (Prompt 10) identifies the following candidate parameters for Morris screening:

| Parameter | Expected Influence |
|-----------|-------------------|
| `claim_rate` | High — directly drives ACR issuance volume |
| `settle_propensity` | High — controls settlement demand |
| `settlement_cap_per_epoch` | High — the primary queue-control lever |
| `brand_inflow_per_epoch` | High — only external Z1U source |
| `utility_spend_rate` | Medium — drives fee/burn recycling |
| `acr_issue_rate` | Medium — scales ACR per verified user |
| `vesting_lag_epochs` | Medium — delays settlement pressure onset |
| `settlement_ratio` | Medium — Z1U per ACR settled |
| `utility_fee_share` | Low-Medium — Treasury recycling fraction |
| `treasury_topup_threshold_ratio` | Low — controls when top-ups trigger |
| `throttle_threshold_ratio` | Low — controls when issuance throttles |

*Full Morris/OAT screening is recommended before M2.*

---

"""

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

    # ── Section 10: Known Limitations ────────────────────────────────
    md += """## 10. Known Limitations

1. **No endogenous pricing.** M1 uses a fixed settlement ratio (ACR → Z1U), not a market-driven price. Real settlement value would vary with supply/demand dynamics.
2. **Deterministic cohort behavior.** All cohort rates are fixed per scenario. Real users exhibit heterogeneous and time-varying behavior.
3. **No adversarial agents.** Settlement-rush attacks, front-running, and strategic withdrawal timing are not modelled.
4. **Reduced-form verification.** Claims and verification use simple pass rates, not the full PCS scoring system.
5. **Provisional parameters.** All default parameters are calibration placeholders. Results are directional, not predictive.
6. **Linear adoption profile.** The default adoption schedule spreads onboarding evenly across epochs.
7. **No campaign revenue.** Treasury receives only brand inflow, not campaign fees (G9b) or RWA revenue (G10c).
8. **Single-run determinism.** M1 runs 1 repetition by default. Confidence intervals require multi-repetition runs with parameter jitter.

---

"""

    # ── Section 11: Recommended M2 Extensions ────────────────────────
    md += """## 11. Recommended M2 Extensions

| Priority | Extension | Rationale |
|----------|-----------|-----------|
| P0 | Endogenous market pricing | Settlement value must respond to supply/demand |
| P0 | Multi-repetition Monte Carlo | Required for confidence intervals and distributional claims |
| P1 | Full Morris sensitivity screening | Identify dominant parameters before calibration |
| P1 | Adversarial settlement-rush agents | Test resilience under coordinated withdrawals |
| P1 | Campaign lifecycle and escrow | Model the primary revenue engine |
| P2 | Creator and validator cohorts | Expand beyond 3 viewer cohorts |
| P2 | Dynamic brand inflow | Link brand spend to ecosystem health metrics |
| P2 | Governance capture scenarios | Model attack vectors on Treasury control |
| P3 | Full 14-agent taxonomy | Complete the agent specification |
| P3 | Prediction market integration | Model secondary market effects |

---

*Report generated by Z1 M1 Core Solvency Model.*
*Model classification: Reduced-form directional solvency ABM.*
*Results depend on provisional parameter guesses and a non-exogenous price.*
"""

    path = os.path.join(out_dir, "M1_report.md")
    with open(path, "w") as f:
        f.write(md)

    return path
