import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import seaborn as sns
import pandas as pd
import numpy as np
import os

# ── Z1 M1 colour palette ────────────────────────────────────────────
_Z1_PALETTE = {
    'ar':        '#2563EB',   # blue
    'treasury':  '#16A34A',   # green
    'queue':     '#EA580C',   # orange
    'pressure':  '#DC2626',   # red
    'utility':   '#7C3AED',   # purple
    'burn':      '#0F172A',   # near-black
    'throttle':  '#64748B',   # slate grey
    'danger':    '#FEE2E2',   # light red fill
    'safe':      '#DCFCE7',   # light green fill
    'warn':      '#FEF9C3',   # light yellow fill
}

_CLASSIFICATION_COLORS = {
    'collapse': '#DC2626',
    'stressed': '#F59E0B',
    'stable':   '#16A34A',
}


def _apply_z1_theme():
    """Set a consistent, professional seaborn theme for all Z1 charts."""
    sns.set_theme(
        style='whitegrid',
        palette='muted',
        rc={
            'figure.figsize': (10, 6),
            'figure.dpi': 150,
            'axes.titlesize': 14,
            'axes.titleweight': 'bold',
            'axes.labelsize': 12,
            'xtick.labelsize': 10,
            'ytick.labelsize': 10,
            'legend.fontsize': 10,
            'grid.alpha': 0.3,
            'font.family': 'sans-serif',
        }
    )


# ═══════════════════════════════════════════════════════════════════════
#  SINGLE-SCENARIO PLOTS  (Prompt 09, items 1–7)
# ═══════════════════════════════════════════════════════════════════════

def create_single_scenario_plots(df: pd.DataFrame, scenario_name: str, out_dir: str):
    """Generate the 7 mandatory single-scenario charts defined in Prompt 09."""
    os.makedirs(out_dir, exist_ok=True)
    _apply_z1_theme()

    epochs = df['epoch']
    # For multi-rep data, compute per-epoch means for fill_between
    if 'run_id' in df.columns:
        epoch_means = df.groupby('epoch').mean(numeric_only=True).reset_index()
    else:
        epoch_means = df
    ep = epoch_means['epoch']

    # ── 1. AR Ratio ──────────────────────────────────────────────────
    fig, ax = plt.subplots()
    ax.fill_between(ep, 0, 0.3, color=_Z1_PALETTE['danger'], alpha=0.5, label='Danger zone (< 0.3)')
    sns.lineplot(data=df, x='epoch', y='ar_ratio', color=_Z1_PALETTE['ar'],
                 linewidth=2, errorbar=('pi', 100), ax=ax)
    ax.axhline(0.3, color=_Z1_PALETTE['pressure'], linestyle='--', linewidth=1, alpha=0.8)
    ax.set_title(f'[{scenario_name}] Audience Reserve Ratio')
    ax.set_xlabel('Epoch')
    ax.set_ylabel('AR / Initial AR')
    ax.set_ylim(bottom=0)
    ax.legend(loc='upper right', framealpha=0.9)
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, '1_ar_ratio.png'))
    plt.close(fig)

    # ── 2. Treasury Balance ──────────────────────────────────────────
    fig, ax = plt.subplots()
    sns.lineplot(data=df, x='epoch', y='treasury', color=_Z1_PALETTE['treasury'],
                 linewidth=2, errorbar=('pi', 100), ax=ax)
    ax.fill_between(ep, 0, epoch_means['treasury'], color=_Z1_PALETTE['treasury'], alpha=0.15)
    ax.set_title(f'[{scenario_name}] Treasury Balance')
    ax.set_xlabel('Epoch')
    ax.set_ylabel('Z1U')
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f'{x:,.0f}'))
    ax.set_ylim(bottom=0)
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, '2_treasury.png'))
    plt.close(fig)

    # ── 3. Settlement Queue ──────────────────────────────────────────
    fig, ax = plt.subplots()
    ax.fill_between(ep, 0, epoch_means['settlement_queue_z1u'],
                    color=_Z1_PALETTE['queue'], alpha=0.3)
    sns.lineplot(data=df, x='epoch', y='settlement_queue_z1u',
                 color=_Z1_PALETTE['queue'], linewidth=2, errorbar=('pi', 100), ax=ax)
    ax.set_title(f'[{scenario_name}] Settlement Queue (Z1U)')
    ax.set_xlabel('Epoch')
    ax.set_ylabel('Requested Z1U')
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f'{x:,.0f}'))
    ax.set_ylim(bottom=0)
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, '3_queue.png'))
    plt.close(fig)

    # ── 4. Settlement Pressure Ratio ─────────────────────────────────
    fig, ax = plt.subplots()
    pressure = epoch_means['settlement_pressure_ratio']
    ax.fill_between(ep, 0, pressure,
                    where=(pressure <= 1.0), color=_Z1_PALETTE['safe'], alpha=0.5, label='Normal')
    ax.fill_between(ep, 0, pressure,
                    where=((pressure > 1.0) & (pressure <= 3.0)),
                    color=_Z1_PALETTE['warn'], alpha=0.5, label='Elevated')
    ax.fill_between(ep, 0, pressure,
                    where=(pressure > 3.0), color=_Z1_PALETTE['danger'], alpha=0.5, label='Critical')
    sns.lineplot(data=df, x='epoch', y='settlement_pressure_ratio',
                 color=_Z1_PALETTE['pressure'], linewidth=2, errorbar=('pi', 100), ax=ax)
    ax.axhline(1.0, color='grey', linestyle=':', linewidth=1)
    ax.set_title(f'[{scenario_name}] Settlement Pressure Ratio')
    ax.set_xlabel('Epoch')
    ax.set_ylabel('Ratio (Queue / Cap)')
    ax.legend(loc='upper left', framealpha=0.9)
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, '4_pressure.png'))
    plt.close(fig)

    # ── 5. Utility Spend per Epoch ───────────────────────────────────
    fig, ax = plt.subplots()
    ax.bar(ep, epoch_means['utility_spend_epoch'], color=_Z1_PALETTE['utility'],
           alpha=0.7, width=0.8, edgecolor=_Z1_PALETTE['utility'], linewidth=0.3)
    ax.set_title(f'[{scenario_name}] Utility Spend Per Epoch')
    ax.set_xlabel('Epoch')
    ax.set_ylabel('Z1U')
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f'{x:,.0f}'))
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, '5_utility.png'))
    plt.close(fig)

    # ── 6. Cumulative Burn ───────────────────────────────────────────
    fig, ax = plt.subplots()
    ax.fill_between(ep, 0, epoch_means['cumulative_z1u_burned'],
                    color=_Z1_PALETTE['burn'], alpha=0.15, step='mid')
    ax.step(ep, epoch_means['cumulative_z1u_burned'], where='mid',
            color=_Z1_PALETTE['burn'], linewidth=2)
    ax.set_title(f'[{scenario_name}] Cumulative Burn')
    ax.set_xlabel('Epoch')
    ax.set_ylabel('Z1U Burned')
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f'{x:,.0f}'))
    ax.set_ylim(bottom=0)
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, '6_burn.png'))
    plt.close(fig)

    # ── 7. Throttle Multiplier ───────────────────────────────────────
    fig, ax = plt.subplots()
    throttle = epoch_means['throttle_multiplier']
    ax.fill_between(ep, throttle, 1.0,
                    where=(throttle < 1.0),
                    color=_Z1_PALETTE['danger'], alpha=0.4, step='mid',
                    label='Throttled')
    ax.step(ep, throttle, where='mid',
            color=_Z1_PALETTE['throttle'], linewidth=2)
    ax.axhline(1.0, color='grey', linestyle=':', linewidth=1)
    ax.set_title(f'[{scenario_name}] Throttle Multiplier')
    ax.set_xlabel('Epoch')
    ax.set_ylabel('Multiplier')
    ax.set_ylim(-0.05, 1.15)
    ax.legend(loc='lower right', framealpha=0.9)
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, '7_throttle.png'))
    plt.close(fig)

    # ═══════════════════════════════════════════════════════════════════════
    #  M2 BENCHMARKING PLOTS
    # ═══════════════════════════════════════════════════════════════════════

    # ── 8. M2 Endogenous Pricing & Dynamic Ratios ────────────────────
    fig, ax1 = plt.subplots()
    ax2 = ax1.twinx()
    sns.lineplot(data=df, x='epoch', y='z1u_price', color=_Z1_PALETTE['ar'], ax=ax1, linewidth=2, errorbar=('pi', 100), label='AMM Spot Price')
    sns.lineplot(data=df, x='epoch', y='dynamic_settlement_ratio', color=_Z1_PALETTE['queue'], ax=ax2, linewidth=2, errorbar=('pi', 100), label='Settlement Ratio')
    ax1.set_title(f'[{scenario_name}] Endogenous Pricing & Settlement Ratio')
    ax1.set_xlabel('Epoch')
    ax1.set_ylabel('Spot Price (USD)', color=_Z1_PALETTE['ar'])
    ax2.set_ylabel('Dynamic Settlement Ratio', color=_Z1_PALETTE['queue'])
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, '8_m2_pricing.png'))
    plt.close(fig)

    # ── 9. M2 Adversarial Panic Cascades ─────────────────────────────
    # Plot settlement queue vs Z1U Price
    fig, ax1 = plt.subplots()
    ax2 = ax1.twinx()
    ax1.fill_between(ep, 0, epoch_means['settlement_queue_z1u'], color=_Z1_PALETTE['queue'], alpha=0.3)
    sns.lineplot(data=df, x='epoch', y='settlement_queue_z1u', color=_Z1_PALETTE['queue'], ax=ax1, linewidth=2, errorbar=('pi', 100), label='Queue')
    sns.lineplot(data=df, x='epoch', y='z1u_price', color=_Z1_PALETTE['pressure'], ax=ax2, linewidth=2, errorbar=('pi', 100), label='Z1U Price', linestyle='--')
    ax1.set_title(f'[{scenario_name}] Panic Cascade (Queue vs Price)')
    ax1.set_xlabel('Epoch')
    ax1.set_ylabel('Settlement Queue (Z1U)', color=_Z1_PALETTE['queue'])
    ax2.set_ylabel('Z1U Price', color=_Z1_PALETTE['pressure'])
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, '9_m2_panic_cascade.png'))
    plt.close(fig)

    # ── 10. M2 Treasury Burn vs Yield ────────────────────────────────
    if 'cumulative_cip_funding' in df.columns:
        fig, ax = plt.subplots()
        sns.lineplot(data=df, x='epoch', y='cumulative_cip_funding', color=_Z1_PALETTE['pressure'], linewidth=2, errorbar=('pi', 100), label='CIP Outflow')
        sns.lineplot(data=df, x='epoch', y='cumulative_ops_costs', color=_Z1_PALETTE['burn'], linewidth=2, errorbar=('pi', 100), label='Ops Outflow')
        sns.lineplot(data=df, x='epoch', y='cumulative_rwa_yield', color=_Z1_PALETTE['treasury'], linewidth=2, errorbar=('pi', 100), label='RWA Yield')
        if 'cumulative_treasury_fees' in df.columns:
            sns.lineplot(data=df, x='epoch', y='cumulative_treasury_fees', color=_Z1_PALETTE['utility'], linewidth=2, errorbar=('pi', 100), label='Utility Fees')
        ax.set_title(f'[{scenario_name}] Treasury Flow (Burn vs Yield)')
        ax.set_xlabel('Epoch')
        ax.set_ylabel('Cumulative Z1U')
        ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f'{x:,.0f}'))
        ax.legend()
        fig.tight_layout()
        fig.savefig(os.path.join(out_dir, '10_m2_treasury_flows.png'))
        plt.close(fig)

    # ── 11. M2 Circuit Breaker Floor Resilience ──────────────────────
    fig, ax = plt.subplots()
    sns.lineplot(data=df, x='epoch', y='ar_ratio', color=_Z1_PALETTE['ar'], linewidth=2, errorbar=('pi', 100), ax=ax)
    # The M2 floor is mathematically exactly 0.25 (or 0.275 with buffer)
    ax.axhline(0.25, color='black', linestyle='-', linewidth=2, label='Constitutional Floor (0.25)')
    ax.axhline(0.275, color=_Z1_PALETTE['pressure'], linestyle='--', linewidth=1, label='Settlement Lock Buffer (0.275)')
    ax.set_title(f'[{scenario_name}] Circuit Breaker Resilience')
    ax.set_xlabel('Epoch')
    ax.set_ylabel('AR / Live Supply Ratio')
    ax.set_ylim(0.2, max(0.35, df['ar_ratio'].max() * 1.05))
    ax.legend()
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, '11_m2_circuit_breaker.png'))
    plt.close(fig)


# ═══════════════════════════════════════════════════════════════════════
#  GRID-LEVEL PLOTS  (Prompt 09, grid items 1–4)
# ═══════════════════════════════════════════════════════════════════════

def create_grid_plots(grid_summary_df: pd.DataFrame, per_epoch_dfs: dict, out_dir: str):
    """
    Generate the 4 grid-level charts required by Prompt 09.

    Args:
        grid_summary_df: DataFrame with one row per scenario (from grid_summary.csv).
        per_epoch_dfs: dict mapping scenario_name -> DataFrame of per-epoch metrics.
        out_dir: directory to write plots into.
    """
    os.makedirs(out_dir, exist_ok=True)
    _apply_z1_theme()

    # Parse scenario name into its 3 axes for heatmap
    grid_summary_df = grid_summary_df.copy()
    grid_summary_df['shock'] = grid_summary_df['scenario'].apply(
        lambda s: s.split('_')[1])
    grid_summary_df['pressure'] = grid_summary_df['scenario'].apply(
        lambda s: s.split('_')[3])
    grid_summary_df['support'] = grid_summary_df['scenario'].apply(
        lambda s: s.split('_')[5])

    axis_order = ['low', 'base', 'high']
    class_map = {'stable': 0, 'stressed': 1, 'collapse': 2}

    # ── 1. Classification Heatmap (faceted by demand_support) ────────
    fig, axes = plt.subplots(1, 3, figsize=(16, 5), sharey=True)
    for idx, support_level in enumerate(axis_order):
        ax = axes[idx]
        subset = grid_summary_df[grid_summary_df['support'] == support_level]
        pivot = subset.pivot_table(
            index='shock', columns='pressure',
            values='classification',
            aggfunc=lambda x: class_map.get(x.iloc[0], -1)
        )
        # Reindex to enforce axis order
        pivot = pivot.reindex(index=axis_order, columns=axis_order)

        # Custom discrete colormap
        from matplotlib.colors import ListedColormap, BoundaryNorm
        cmap = ListedColormap([_CLASSIFICATION_COLORS['stable'],
                               _CLASSIFICATION_COLORS['stressed'],
                               _CLASSIFICATION_COLORS['collapse']])
        bounds = [-0.5, 0.5, 1.5, 2.5]
        norm = BoundaryNorm(bounds, cmap.N)

        sns.heatmap(pivot, ax=ax, cmap=cmap, norm=norm,
                    annot=subset.pivot_table(index='shock', columns='pressure',
                                             values='classification', aggfunc='first')
                    .reindex(index=axis_order, columns=axis_order),
                    fmt='s', linewidths=1, linecolor='white',
                    cbar=False, square=True)
        ax.set_title(f'Support = {support_level}', fontsize=12, fontweight='bold')
        ax.set_xlabel('Settlement Pressure')
        if idx == 0:
            ax.set_ylabel('Migration Shock')
        else:
            ax.set_ylabel('')

    fig.suptitle('Z1 M2 — 27-Scenario Classification Grid', fontsize=14, fontweight='bold', y=1.02)
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, 'grid_1_classification_heatmap.png'), bbox_inches='tight')
    plt.close(fig)

    # ── 2. Worst scenarios by min_ar_ratio ───────────────────────────
    fig, ax = plt.subplots(figsize=(12, 6))
    worst_ar = grid_summary_df.nsmallest(10, 'min_ar_ratio')[['scenario', 'min_ar_ratio', 'classification']].copy()
    worst_ar = worst_ar.sort_values('min_ar_ratio', ascending=True)
    colors = [_CLASSIFICATION_COLORS.get(c, '#888') for c in worst_ar['classification']]
    ax.barh(worst_ar['scenario'], worst_ar['min_ar_ratio'], color=colors, edgecolor='white', linewidth=0.5)
    ax.axvline(0.3, color=_Z1_PALETTE['pressure'], linestyle='--', linewidth=1, label='Collapse threshold')
    ax.set_title('Worst 10 Scenarios by Minimum AR Ratio')
    ax.set_xlabel('Min AR Ratio')
    ax.legend(loc='lower right')
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, 'grid_2_worst_ar_ratio.png'))
    plt.close(fig)

    # ── 3. Worst scenarios by max_settlement_queue_z1u ────────────────
    fig, ax = plt.subplots(figsize=(12, 6))
    worst_q = grid_summary_df.nlargest(10, 'max_settlement_queue_z1u')[
        ['scenario', 'max_settlement_queue_z1u', 'classification']].copy()
    worst_q = worst_q.sort_values('max_settlement_queue_z1u', ascending=True)
    colors = [_CLASSIFICATION_COLORS.get(c, '#888') for c in worst_q['classification']]
    ax.barh(worst_q['scenario'], worst_q['max_settlement_queue_z1u'],
            color=colors, edgecolor='white', linewidth=0.5)
    ax.set_title('Worst 10 Scenarios by Max Settlement Queue')
    ax.set_xlabel('Max Settlement Queue (Z1U)')
    ax.xaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f'{x:,.0f}'))
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, 'grid_3_worst_queue.png'))
    plt.close(fig)

    # ── 4. AR Ratio Trajectory Comparison (all 27) ───────────────────
    if per_epoch_dfs:
        fig, ax = plt.subplots(figsize=(12, 7))
        for scenario_name, epoch_df in per_epoch_dfs.items():
            row = grid_summary_df[grid_summary_df['scenario'] == scenario_name]
            if row.empty:
                classification = 'stable'
            else:
                classification = row.iloc[0]['classification']
            color = _CLASSIFICATION_COLORS.get(classification, '#888')
            alpha = 0.8 if classification == 'collapse' else 0.5
            ax.plot(epoch_df['epoch'], epoch_df['ar_ratio'],
                    color=color, alpha=alpha, linewidth=0.8)

        ax.axhline(0.3, color=_Z1_PALETTE['pressure'], linestyle='--',
                   linewidth=1.5, label='Collapse threshold (0.3)')
        ax.fill_between(range(0, 300), 0, 0.3,
                        color=_Z1_PALETTE['danger'], alpha=0.2)

        # Legend entries
        from matplotlib.lines import Line2D
        legend_elements = [
            Line2D([0], [0], color=_CLASSIFICATION_COLORS['collapse'], lw=2, label='Collapse'),
            Line2D([0], [0], color=_CLASSIFICATION_COLORS['stressed'], lw=2, label='Stressed'),
            Line2D([0], [0], color=_CLASSIFICATION_COLORS['stable'], lw=2, label='Stable'),
            Line2D([0], [0], color=_Z1_PALETTE['pressure'], lw=1.5, linestyle='--', label='Threshold'),
        ]
        ax.legend(handles=legend_elements, loc='upper right', framealpha=0.9)
        ax.set_title('Z1 M2 — AR Ratio Trajectories (27 Scenarios)')
        ax.set_xlabel('Epoch')
        ax.set_ylabel('AR / Initial AR')
        # Allow y-axis to auto-scale because M2 inflation pushes AR far above 1.15
        fig.tight_layout()
        fig.savefig(os.path.join(out_dir, 'grid_4_ar_trajectories.png'))
        plt.close(fig)
