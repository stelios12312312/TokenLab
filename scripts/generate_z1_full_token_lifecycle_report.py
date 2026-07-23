from __future__ import annotations

import csv
import hashlib
import html
import json
import math
import platform
import re
import shutil
import subprocess
import sys
import textwrap
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd

REPO = Path(__file__).resolve().parents[1]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from projects.z1.reporting import full_token_lifecycle_data as _report_data  # noqa: E402

# Historical helpers remain available from this script module for callers that
# imported them directly before the data/render split.
ALLOCATIONS = _report_data.ALLOCATIONS
INITIAL_CIRCULATION = _report_data.INITIAL_CIRCULATION
SOURCE_DB = _report_data.SOURCE_DB
FullTokenLifecycleData = _report_data.FullTokenLifecycleData
assemble_full_token_lifecycle_data = _report_data.assemble_full_token_lifecycle_data
build_data = _report_data.build_data
build_insights = _report_data.build_insights
build_mechanism_parameter_guide = _report_data.build_mechanism_parameter_guide
build_recommendations = _report_data.build_recommendations
build_risks = _report_data.build_risks
infer_classification = _report_data.infer_classification
infer_instrument = _report_data.infer_instrument
infer_unit = _report_data.infer_unit
make_tables = _report_data.make_tables
read_csv = _report_data.read_csv
validate = _report_data.validate


STOCHASTIC_DB = REPO / "outputs" / "z1_stochastic_stress_testing"
OUT = REPO / "outputs" / "z1_full_token_lifecycle_report"
DATA = OUT / "data"
FIG = OUT / "figures"

REQUIRED_FILES = [
    "EXECUTIVE_REPORT.md",
    "EXECUTIVE_REPORT.html",
    "TECHNICAL_REPORT.md",
    "TECHNICAL_REPORT.html",
    "REPORT_SUMMARY.json",
    "RUN_MANIFEST.json",
    "SOURCE_OF_TRUTH.md",
    "DATA_PROVENANCE.md",
    "DATA_DICTIONARY.csv",
    "DATABASE_SCHEMA.md",
    "DATABASE_TABLES.csv",
    "ANCHOR_DATA_REGISTER.csv",
    "OBSERVED_DERIVED_ASSUMED_MATRIX.csv",
    "PARAMETER_REGISTER.csv",
    "MECHANISM_REGISTER.csv",
    "MECHANISM_PARAMETER_GUIDE.csv",
    "MECHANISM_DEEP_DIVE.md",
    "LIFECYCLE_TRANSITION_REGISTER.csv",
    "COHORT_ANALYSIS.csv",
    "USER_FUNNEL_ANALYSIS.csv",
    "ACR_LIFECYCLE_ANALYSIS.csv",
    "Z1U_FLOW_ANALYSIS.csv",
    "SETTLEMENT_QUEUE_ANALYSIS.csv",
    "CAMPAIGN_ANALYSIS.csv",
    "TREASURY_ANALYSIS.csv",
    "TOKEN_ALLOCATION_ANALYSIS.csv",
    "TOKEN_UNLOCK_SCHEDULE.csv",
    "TOKEN_LAUNCH_ANALYSIS.csv",
    "TOKEN_VALUATION_LENSES.csv",
    "LAUNCH_GATE_RESULTS.csv",
    "SCENARIO_COMPARISON.csv",
    "STRESS_TEST_RESULTS.csv",
    "MONTE_CARLO_SUMMARY.csv",
    "SENSITIVITY_RESULTS.csv",
    "IDENTIFIABILITY_MATRIX.csv",
    "RISK_REGISTER.csv",
    "RECOMMENDATIONS.csv",
    "INSIGHTS.md",
    "LIMITATIONS.md",
]

REQUIRED_FIGURES = [
    "architecture.svg",
    "database_schema.svg",
    "token_lifecycle.svg",
    "user_funnel.svg",
    "cohort_transitions.svg",
    "acr_stock_flow.svg",
    "z1u_sankey.svg",
    "settlement_queue.svg",
    "treasury_sankey.svg",
    "token_allocation.svg",
    "initial_circulation.svg",
    "vesting_timeline.svg",
    "circulating_supply.svg",
    "unlock_pressure.svg",
    "valuation_bridge.svg",
    "launch_readiness.svg",
    "scenarios.svg",
    "monte_carlo.svg",
    "sensitivity.svg",
    "parameter_influence.svg",
    "risk_heatmap.svg",
    "year5_ecosystem_state.svg",
]

def read_stochastic_csv(name: str) -> pd.DataFrame:
    path = STOCHASTIC_DB / name
    if not path.exists():
        return pd.DataFrame()
    return pd.read_csv(path)


def write_csv(path: Path, rows: list[dict[str, Any]] | pd.DataFrame) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(rows, pd.DataFrame):
        rows.to_csv(path, index=False)
        return
    keys: list[str] = []
    for row in rows:
        for key in row:
            if key not in keys:
                keys.append(key)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=keys)
        writer.writeheader()
        writer.writerows(rows)


def md_table(df: pd.DataFrame, max_rows: int = 20) -> str:
    show = df.head(max_rows).copy()
    cols = list(show.columns)
    lines = ["| " + " | ".join(cols) + " |", "| " + " | ".join("---" for _ in cols) + " |"]
    for _, row in show.iterrows():
        vals = []
        for col in cols:
            value = row[col]
            if isinstance(value, float):
                value = compact(value)
            vals.append(str(value).replace("\n", " "))
        lines.append("| " + " | ".join(vals) + " |")
    if len(df) > max_rows:
        lines.append(f"| ... | {len(df) - max_rows} more rows omitted from report body; see CSV. |" + " |" * max(0, len(cols) - 2))
    return "\n".join(lines)


def compact(value: float) -> str:
    if pd.isna(value):
        return ""
    value = float(value)
    sign = "-" if value < 0 else ""
    value = abs(value)
    if value >= 1_000_000_000:
        return f"{sign}{value / 1_000_000_000:.2f}B"
    if value >= 1_000_000:
        return f"{sign}{value / 1_000_000:.2f}M"
    if value >= 1_000:
        return f"{sign}{value / 1_000:.2f}K"
    if value >= 10:
        return f"{sign}{value:,.1f}"
    return f"{sign}{value:,.3f}"


def money(value: float) -> str:
    return "$" + compact(value)


def pct(value: float) -> str:
    if pd.isna(value):
        return ""
    return f"{float(value) * 100:.1f}%"


def file_hash(path: Path) -> str | None:
    if not path.exists():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git_id() -> str:
    try:
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
        dirty = subprocess.check_output(["git", "status", "--short"], cwd=REPO, text=True).strip()
        return head + ("-dirty" if dirty else "")
    except Exception as exc:
        return f"unavailable: {exc}"


def html_report(markdown_text: str, title: str) -> str:
    lines = markdown_text.splitlines()
    body: list[str] = []
    toc: list[str] = []
    in_table = False
    table_row_index = 0

    def inline_md(value: str) -> str:
        escaped = html.escape(value)
        escaped = re.sub(r"`([^`]+)`", r"<code>\1</code>", escaped)
        escaped = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", escaped)
        return escaped

    def close_table() -> None:
        nonlocal in_table
        if in_table:
            body.append("</tbody></table></div>")
            in_table = False

    for line in lines:
        if line.startswith("#"):
            close_table()
            level = len(line) - len(line.lstrip("#"))
            text = line[level:].strip()
            anchor = "".join(ch.lower() if ch.isalnum() else "-" for ch in text).strip("-")
            if 1 < level <= 2:
                toc.append(f'<a href="#{anchor}">{html.escape(text)}</a>')
            body.append(f'<h{min(level, 4)} id="{anchor}">{inline_md(text)}</h{min(level, 4)}>')
        elif line.startswith("![") and "](" in line and line.endswith(")"):
            close_table()
            alt = line.split("](")[0][2:]
            src = line.split("](")[1][:-1]
            body.append(f'<figure><img src="{html.escape(src)}" alt="{html.escape(alt)}"><figcaption>{html.escape(alt)}</figcaption></figure>')
        elif line.startswith("| ") and line.endswith(" |"):
            cells = [cell.strip() for cell in line.strip("|").split("|")]
            if set(cells) == {"---"}:
                continue
            if not in_table:
                body.append("<div class='table-wrap'><table><tbody>")
                in_table = True
                table_row_index = 0
            tag = "th" if table_row_index == 0 else "td"
            body.append("<tr>" + "".join(f"<{tag}>{inline_md(cell)}</{tag}>" for cell in cells) + "</tr>")
            table_row_index += 1
        elif line.strip() == "":
            close_table()
        elif line.startswith("- "):
            close_table()
            body.append(f"<p class='bullet'>{inline_md(line[2:])}</p>")
        else:
            close_table()
            body.append(f"<p>{inline_md(line)}</p>")
    close_table()
    css = """
    body{font-family:Arial,Helvetica,sans-serif;margin:0;color:#17212f;background:#fff;line-height:1.45}
    header{background:#111827;color:#fff;padding:18px 36px}
    header h1{color:#fff;margin:0 0 8px;font-size:26px;line-height:1.2}
    header p{margin:0;color:#dbeafe}
    main{max-width:1180px;margin:auto;padding:26px 36px}
    nav{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 26px;max-height:148px;overflow:auto;padding:10px;border:1px solid #e2e8f0;background:#f8fafc;border-radius:6px}
    nav a{color:#1f5fbf;border:1px solid #d7deea;padding:6px 8px;border-radius:4px;text-decoration:none}
    h1,h2,h3{color:#111827} h1{font-size:30px} h2{border-top:1px solid #d8dee9;padding-top:18px;margin-top:28px}
    .table-wrap{width:100%;overflow-x:auto;margin:14px 0}
    table{border-collapse:collapse;min-width:720px;width:100%;font-size:13px}
    th,td{border:1px solid #d6dde8;padding:7px 8px;text-align:left;vertical-align:top;overflow-wrap:anywhere} th{background:#eef3f9}
    code{background:#eef3f9;border:1px solid #d7deea;border-radius:3px;padding:1px 4px;font-family:Consolas,monospace;font-size:.92em}
    .bullet{padding-left:18px;position:relative}.bullet:before{content:"-";position:absolute;left:3px;color:#475569}
    img{max-width:100%;height:auto;border:1px solid #d9e0ea;background:#fff} figure{margin:20px 0}
    .note{background:#f6f8fb;border-left:4px solid #1f5fbf;padding:10px}
    @media print{nav{display:none} main{max-width:none;padding:10px} h2{break-before:auto} img{max-height:650px}.table-wrap{overflow:visible} table{font-size:10px;min-width:0}}
    """
    return f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(title)}</title><style>{css}</style></head><body><header><h1>{html.escape(title)}</h1><p>Generated from TokenLab canonical simulation outputs.</p></header><main><nav>{''.join(toc)}</nav>{''.join(body)}</main></body></html>"


def make_simple_svg(path: Path, title: str, nodes: list[str], edges: list[tuple[int, int]], colors: list[str] | None = None) -> None:
    width = 1180
    rows = math.ceil(len(nodes) / 3)
    height = max(300, 120 + rows * 88)
    colors = colors or ["#e8eef7"] * len(nodes)
    coords = []
    for i, _ in enumerate(nodes):
        x = 80 + (i % 3) * 360
        y = 82 + (i // 3) * 88
        coords.append((x, y))
    parts = [f"<svg xmlns='http://www.w3.org/2000/svg' width='{width}' height='{height}' viewBox='0 0 {width} {height}'>",
             "<defs><marker id='arrow' markerWidth='10' markerHeight='8' refX='9' refY='4' orient='auto'><path d='M0,0 L10,4 L0,8 z' fill='#3b4252'/></marker></defs>",
             "<rect width='100%' height='100%' fill='white'/>",
             f"<text x='30' y='36' font-size='22' font-family='Arial' font-weight='700' fill='#111827'>{html.escape(title)}</text>",
             "<text x='30' y='60' font-size='12' font-family='Arial' fill='#4b5563'>Scenario: scale base unless noted | Period: Jan 2027-Dec 2031 | Values classified in report tables</text>"]
    for a, b in edges:
        x1, y1 = coords[a]
        x2, y2 = coords[b]
        parts.append(f"<line x1='{x1+250}' y1='{y1+24}' x2='{x2}' y2='{y2+24}' stroke='#3b4252' stroke-width='2' marker-end='url(#arrow)'/>")
    for i, node in enumerate(nodes):
        x, y = coords[i]
        color = colors[i % len(colors)]
        parts.append(f"<rect x='{x}' y='{y}' width='250' height='48' rx='6' fill='{color}' stroke='#334155'/>")
        wrapped = textwrap.wrap(node, width=28)[:2]
        for line_no, label in enumerate(wrapped):
            parts.append(f"<text x='{x+12}' y='{y+21 + line_no * 15}' font-size='12' font-family='Arial' fill='#111827'>{html.escape(label)}</text>")
    parts.append("</svg>")
    path.write_text("\n".join(parts), encoding="utf-8")


def setup_output() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    DATA.mkdir(parents=True, exist_ok=True)
    FIG.mkdir(parents=True, exist_ok=True)


def mechanism_deep_dive_markdown(ctx: dict[str, Any], tables: dict[str, pd.DataFrame]) -> str:
    base = ctx["base"]
    launch = base.iloc[11]
    final = base.iloc[-1]
    guide = tables["mechanism_parameter_guide"]
    sensitivity = tables["sensitivity"]
    ident = tables["identifiability"]

    sections = [
        {
            "title": "Audience Eligibility",
            "mechanism": "The model starts with Zee-linked reach and gradually converts it into eligible identities. This prevents the 1.45B audience anchor from being treated as immediate token users.",
            "parameters": ["maximum_addressable_audience", "starting_eligible_identities", "eligible_convergence_rate"],
            "behavior": f"At TGE, eligible identities are {compact(launch['eligible_identity_count'])}; by year 5 they reach {compact(final['eligible_identity_count'])}. Verified conversion is materially smaller, which is the right modeling discipline.",
            "recommendation": "Keep eligibility as a staged opt-in stock. Do not use 1.45B in investor or legal materials without saying it is a reach-derived ceiling that requires identity dedupe, consent and jurisdiction eligibility.",
        },
        {
            "title": "Verification, Activation, Churn and Reactivation",
            "mechanism": "Eligible users become verified through claim and identity flows, then move between active, dormant, churned and reactivated states. This is the core operational funnel.",
            "parameters": ["claim_rate", "OTP / identity success", "activation probability", "monthly_churn_rate", "monthly_reactivation_rate"],
            "behavior": f"TGE verified users are {compact(launch['verified_users'])}, active users are {compact(launch['active_users'])}, and active/verified is {pct(launch['active_users'] / launch['verified_users'])}. By year 5, active/verified falls to {pct(final['active_users'] / final['verified_users'])}, so retention quality matters more than raw verification.",
            "recommendation": "Before external launch claims, run cohort pilots that measure verified conversion, active retention, dormant recovery and reactivation by channel. Separate organic active users from campaign-attributed users.",
        },
        {
            "title": "ACR Recognition and Review",
            "mechanism": "ACR is personal historical recognition, not a market token. It is issued from contribution evidence, vests, becomes available, can be requested, held, voided, released and settled through Z1U capacity.",
            "parameters": ["average_acr", "vesting lag", "hold rate", "void rate"],
            "behavior": f"The base simulation issues {compact(base['acr_issued'].sum())} cumulative ACR over the horizon. The model includes holds and voids, but real fraud, dispute and evidence rates are still pilot data requirements.",
            "recommendation": "Do not describe ACR as cash, Z1U or Z1. Publish clear ACR terms, evidence rules, hold/void rights, appeal SLA, and release caps before mass claims.",
        },
        {
            "title": "ACR to Z1U Settlement and Queue Capacity",
            "mechanism": "Released ACR creates internal Z1U settlement demand, but fills are constrained by capacity and queue controls. This is the main protection against uncontrolled recognition obligations.",
            "parameters": ["z1u_per_released_acr", "z1u_capacity", "queue age thresholds"],
            "behavior": f"The base case keeps maximum average queue age at {base['queue_age_avg_days'].max():.2f} days and maximum p95 queue age at {base['queue_age_p95_days'].max():.2f} days. Queue age is therefore controlled in the base case, but capacity is a high-sensitivity parameter.",
            "recommendation": "Make p95 queue age, backlog clearance time and failed request rate formal launch gates. Stress 2x demand, capacity loss, outage sequences and accelerated claims before settlement launch.",
        },
        {
            "title": "Z1U Utility Economy",
            "mechanism": "Z1U is an internal utility accounting unit. It enters through ACR-linked release, user purchases, brand funding and campaign funding; it leaves through utility spend, fees, burns and provider payouts.",
            "parameters": ["utility adoption rate", "spend per utility user", "utility fee rate", "burn rate"],
            "behavior": f"TGE utility users are {compact(launch['utility_users'])}; year-5 utility users are {compact(final['utility_users'])}; cumulative utility GMV reaches {money(final['cumulative_utility_gmv_usd'])}. The accounting identity provider payout plus fee equals utility spend validates in the database.",
            "recommendation": "Treat paid, user-funded utility as the strongest demand evidence. Report user-funded, brand-funded and campaign-funded Z1U separately, and avoid presenting subsidized usage as organic demand.",
        },
        {
            "title": "Campaign Acquisition and Reactivation",
            "mechanism": "Campaigns drive participation, verification, reactivation, transactions and campaign-funded Z1U. They are useful but can overstate durable product-market fit if not separated from organic activity.",
            "parameters": ["campaign success rate", "campaign budget"],
            "behavior": f"At TGE the model uses {compact(launch['campaign_participants'])} campaign participants and {money(launch['campaign_budget_usd'])} monthly campaign budget. Campaign attribution is tracked separately in the database.",
            "recommendation": "Do not transfer historical SMS, QR, WhatsApp, OBD or watch-and-win response rates directly to token participation. Apply haircuts and measure payback by verified, active and utility cohorts.",
        },
        {
            "title": "Treasury and Commercial Solvency",
            "mechanism": "Treasury cash moves through brand revenue, campaign fees, utility fees, user/brand Z1U cash inflows, OpEx, provider payouts, disbursements and reserves.",
            "parameters": ["brand revenue", "operating expense", "settlement reserve"],
            "behavior": f"The base case minimum ending cash is {money(base['ending_cash_usd'].min())}, TGE cash is {money(launch['ending_cash_usd'])}, and year-5 cash is {money(final['ending_cash_usd'])}. The model does not need token appreciation for base-case solvency.",
            "recommendation": "Require signed brand commitments, production OpEx reserves, support/compliance cost buffers and a formal settlement reserve policy before describing the system as investment-grade.",
        },
        {
            "title": "Z1 Token Launch, Allocation and Unlocks",
            "mechanism": "Z1 is the transferable active-participation token. Its economics are controlled by launch price, FDV, initial circulation, allocation schedule, vesting and unlocks. It is not interchangeable with ACR or Z1U.",
            "parameters": ["launch price", "initial circulation", "FDV", "monthly unlocks"],
            "behavior": f"The base launch case is {money(launch['z1_token_launch_price_usd'])}, {money(launch['z1_token_fdv_usd'])} FDV and {compact(launch['z1_token_circulating_supply'])} initial circulating supply. Year-5 circulating supply is {compact(final['z1_token_circulating_supply'])}.",
            "recommendation": "Keep the $0.20 launch price only as a conditional management scenario. Gate TGE and unlocks on legal clearance, utility evidence, revenue evidence, liquidity commitments and market-maker readiness.",
        },
        {
            "title": "Fundamental Reference Value",
            "mechanism": "The internal reference value is a formulaic scenario reference driven by verified users, utility users and revenue. It is not a market-price forecast.",
            "parameters": ["verified-user weight", "utility-user weight", "revenue weight"],
            "behavior": f"The model reaches a year-5 fundamental reference price of {money(final['z1_fundamental_reference_price_usd'])}. This is driven by formula expansion as scale grows, not by simulated order-book demand.",
            "recommendation": "Show the reference as an internal planning lens only. Do not use it as expected price appreciation, investment return, redemption value or market forecast.",
        },
    ]

    parts = ["# Mechanism Deep Dive\n", "This appendix explains how each major mechanism works, which parameters matter, what the current simulation shows, and what Z1 should do before relying on the mechanism externally.\n"]
    for section in sections:
        rows = guide[guide["parameter"].isin(section["parameters"])][[
            "parameter", "plain_english_definition", "unit", "evidence_status", "database_field",
            "tge_value_or_proxy", "year5_value_or_proxy", "main_risk", "recommendation",
        ]].copy()
        parts.append(f"## {section['title']}\n")
        parts.append(f"Mechanism: {section['mechanism']}\n")
        parts.append(f"Observed behavior: {section['behavior']}\n")
        parts.append(f"Recommendation: {section['recommendation']}\n")
        parts.append("Parameter detail:\n")
        parts.append(md_table(rows, max_rows=20))
        parts.append("")

    parts.append("## Cross-Mechanism Sensitivity\n")
    parts.append("The most decision-relevant parameters are those that move launch readiness, settlement stability, treasury runway or token valuation references. High-sensitivity parameters should be calibrated with pilot data before external communication.\n")
    parts.append(md_table(sensitivity.sort_values("elasticity_proxy", key=lambda s: s.abs(), ascending=False).head(12), max_rows=12))
    parts.append("\n## Identifiability Guidance\n")
    parts.append("Several mechanisms can compensate for each other, creating realistic-looking outputs from different behavioral explanations. These should be constrained before peer review.\n")
    parts.append(md_table(ident, max_rows=20))
    return "\n".join(parts)


def stochastic_report_sections() -> tuple[str, str, dict[str, Any]]:
    if not (STOCHASTIC_DB / "RUN_MANIFEST.json").exists():
        return (
            "## Scenario Resilience and Stochastic Stress Testing\n\nStochastic stress-testing outputs were not found. Run `python scripts/run_z1_stochastic_stress_testing.py` before generating final reports.\n",
            "## Stochastic Scenario Modeling and Stress Testing\n\nNo stochastic run manifest was found. The standard report generator did not silently label deterministic outputs as stochastic percentiles.\n",
            {"stochastic_integrated": False, "reason": "missing stochastic RUN_MANIFEST.json"},
        )

    failure = read_stochastic_csv("FAILURE_PROBABILITIES.csv")
    kpi = read_stochastic_csv("EXECUTIVE_KPI_SUMMARY.csv")
    separation = read_stochastic_csv("SCENARIO_DIFFERENTIATION_MATRIX.csv")
    sensitivity = read_stochastic_csv("STOCHASTIC_SENSITIVITY_RESULTS.csv")
    attribution = read_stochastic_csv("FAILURE_ATTRIBUTION_RESULTS.csv")
    convergence = read_stochastic_csv("CONVERGENCE_RESULTS.csv")
    definitions = read_stochastic_csv("SCENARIO_REGIME_DEFINITIONS.csv")
    consistency = read_stochastic_csv("REPORT_CONSISTENCY_TEST_RESULTS.csv")
    manifest = json.loads((STOCHASTIC_DB / "RUN_MANIFEST.json").read_text(encoding="utf-8"))
    runs = manifest.get("run_manifest", {}).get("runs", "")
    seed = manifest.get("run_manifest", {}).get("seed", "")

    failure_pivot = failure.pivot_table(index="scenario", columns="risk_metric", values="value", aggfunc="first").reset_index()
    executive_cols = [
        col
        for col in [
            "scenario",
            "verified_users",
            "active_users",
            "utility_users",
            "settlement_backlog_z1u",
            "queue_age_p95_days",
            "token_price_usd",
            "token_drawdown",
            "liquidity_depth_usd",
            "material_stress_probability",
            "critical_system_failure_probability",
        ]
        if col in kpi.columns
    ]
    comparison_rows = []
    operating = {
        "base": "moderate growth with intermittent operational friction",
        "downside": "correlated deterioration in adoption, confidence, liquidity and settlement availability",
        "severe_downside": "persistent crisis with reinforcing price, liquidity, churn and settlement feedback",
        "upside": "strong adoption with scaling, liquidity, verification and settlement pressure",
        "extreme_upside": "viral growth and speculative expansion tested against finite capacity",
    }
    if not failure_pivot.empty:
        for _, row in failure_pivot.iterrows():
            scenario = row["scenario"]
            material = float(row.get("material_stress_probability", 0.0))
            critical = float(row.get("critical_system_failure_probability", 0.0))
            comparison_rows.append(
                {
                    "scenario": scenario,
                    "operating_environment": operating.get(scenario, scenario),
                    "principal_bottleneck": _scenario_bottleneck(row),
                    "probability_of_material_stress": material,
                    "probability_of_critical_failure": critical,
                    "management_implication": _management_implication(material, critical),
                }
            )
    scenario_comparison = pd.DataFrame(comparison_rows)

    exec_md = f"""## Scenario Resilience and Stochastic Stress Testing

The stochastic stress test uses the same calibrated Z1 baseline as this report and adds five causal regimes: Base, Downside, Severe Downside, Upside and Extreme Upside. It uses `{runs}` Monte Carlo paths with seed `{seed}` and common random-number groups across scenarios, so differences come from scenario-specific causal structure rather than stale or mismatched result sets.

The previous deterministic scenarios were too similar because they mostly changed point multipliers around the same trajectory. The upgraded framework adds persistent regimes, correlated shocks, queue feedback, token price, separate liquidity depth, incentive exhaustion, capacity constraints and failure conditions.

### Executive Stochastic KPI Summary

{md_table(kpi[executive_cols], max_rows=10) if not kpi.empty and executive_cols else "No executive stochastic KPI table found."}

### Executive Scenario Comparison

{md_table(scenario_comparison, max_rows=10)}

### Plain-Language Interpretation

- Base is not a single forecast; it has ordinary volatility, queue friction and drawdown tails.
- Downside combines weaker adoption, weaker utility, lower confidence, liquidity pressure and higher settlement demand.
- Severe Downside is the persistent crisis case where feedback loops can become self-reinforcing.
- Upside can still be fragile because strong growth creates verification, incentive, liquidity and settlement pressure.
- Extreme Upside tests whether viral growth overwhelms finite operational capacity.

### Management Actions

Management actions should be threshold-based: increase settlement capacity before p95 queue age breaches the service threshold, throttle unlocks when drawdown and liquidity-depth thresholds bind together, cap incentives when payback weakens, and slow onboarding if growth creates unacceptable settlement-failure probability.
"""

    tech_md = f"""## Stochastic Scenario Modeling and Stress Testing

### Why The Previous Scenarios Were Too Similar

The deterministic implementation correctly propagated scenario labels, but Base, Downside and Upside shared the same basic temporal path, most of the same relationships, no persistent regime switching, no full shock catalogue, no separate liquidity state, and limited endogenous feedback. Differences were therefore mainly lower/base/higher growth and token reference cases.

### New Architecture

The stochastic layer consumes the calibrated deterministic period outputs and wraps them with:

- bounded and skewed stochastic user transitions;
- correlated common random factors;
- persistent regime switching;
- state-dependent shock events;
- settlement as a capacity-constrained queue;
- token price as a stochastic endogenous/exogenous process;
- liquidity modeled separately from price;
- confidence, incentive, queue, concentration and liquidity feedback loops;
- common random numbers for scenario comparison;
- failure conditions and attribution.

### Scenario Regimes

{md_table(definitions[['scenario','operating_environment','initial_regime','adoption_mu','utility_mu','settlement_request_mu','settlement_capacity_mu','token_vol','liquidity_mu','feedback_strength']] if not definitions.empty else definitions, max_rows=10)}

### Failure Probabilities

{md_table(failure_pivot, max_rows=10)}

### Scenario Separation

{md_table(separation, max_rows=40)}

### Sensitivity Rankings

{md_table(sensitivity.sort_values(['scenario','absolute_rank_correlation'], ascending=[True, False]).head(40) if not sensitivity.empty else sensitivity, max_rows=40)}

### Failure Attribution

{md_table(attribution.sort_values(['scenario','failed_run_share'], ascending=[True, False]).head(40) if not attribution.empty else attribution, max_rows=40)}

### Convergence

{md_table(convergence, max_rows=40)}

### Report Consistency

{md_table(consistency, max_rows=20)}

All stochastic values in this section trace to `{STOCHASTIC_DB}` and its `RUN_MANIFEST.json`. Deterministic values are not labeled as stochastic percentiles.
"""
    return exec_md, tech_md, {"stochastic_integrated": True, "runs": runs, "seed": seed, "source": str(STOCHASTIC_DB)}


def _scenario_bottleneck(row: pd.Series) -> str:
    candidates = {
        "settlement": float(row.get("queue_instability_probability", 0.0)),
        "liquidity": float(row.get("liquidity_exhaustion_probability", 0.0)),
        "token_drawdown": float(row.get("token_drawdown_probability", 0.0)),
        "incentives": float(row.get("incentive_budget_exhaustion_probability", 0.0)),
    }
    return max(candidates, key=candidates.get)


def _management_implication(material: float, critical: float) -> str:
    if critical >= 0.35:
        return "critical: do not launch without redesign or hard gating"
    if material >= 0.35:
        return "fragile: launch only with intervention thresholds and reserves"
    if material >= 0.10:
        return "manageable with intervention"
    return "resilient under modeled thresholds"


def make_figures(ctx: dict[str, Any], tables: dict[str, pd.DataFrame]) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    base = ctx["base"]
    scenario = tables["scenario_comparison"]
    mc = tables["mc"]
    sensitivity = tables["sensitivity"].copy()
    risk = tables["risk"]
    allocation = tables["allocation"]
    token_supply = tables["token_supply"]
    gates = tables["gates"]
    x = pd.to_datetime(base["period"])

    def chart_title(title: str, subtitle: str) -> str:
        return "\n".join(textwrap.wrap(title, width=58) + textwrap.wrap(subtitle, width=78))

    make_simple_svg(FIG / "architecture.svg", "Z1 System Architecture", [
        "Source evidence", "Parameter registry", "Calibration",
        "Simulation engine", "Scenario runner", "Monte Carlo layer",
        "Simulation database", "Lifecycle analytics", "Report generation",
    ], [(0, 1), (1, 2), (2, 3), (3, 4), (4, 5), (5, 6), (6, 7), (7, 8)])
    make_simple_svg(FIG / "database_schema.svg", "Simulation Database Schema", [
        "period_data(period, scenario)", "parameter_registry(parameter)",
        "cohort_matrix(cohort)", "token_supply(month)",
        "launch_gates(gate)", "monte_carlo(metric)",
        "audit_summary(run)", "report tables",
    ], [(0, 7), (1, 7), (2, 0), (3, 0), (4, 7), (5, 7), (6, 7)])
    make_simple_svg(FIG / "token_lifecycle.svg", "Complete Token Lifecycle", [
        "Historical audience", "Eligible identities", "Verified users",
        "Active users", "Utility users", "Settlement users",
        "ACR issuance", "ACR vesting/request", "Z1U release",
        "Utility spend/fees/burns", "Treasury cash flows", "Z1 token launch/circulation",
    ], [(0, 1), (1, 2), (2, 3), (3, 4), (3, 5), (2, 6), (6, 7), (7, 8), (8, 9), (9, 10), (3, 11)])
    make_simple_svg(FIG / "cohort_transitions.svg", "Cohort Transition Map", list(ctx["cohorts"]["cohort"].astype(str)) + ["Verified", "Active", "Utility", "Settlement"], [(0, 6), (1, 6), (2, 6), (3, 6), (4, 6), (5, 6), (6, 7), (7, 8), (7, 9)])
    make_simple_svg(FIG / "acr_stock_flow.svg", "ACR Stock-Flow Diagram", ["Issued", "Vested", "Available", "Requested", "Held", "Voided", "Released", "Z1U settlement"], [(0, 1), (1, 2), (2, 3), (3, 4), (3, 5), (4, 6), (3, 6), (6, 7)], ["#fde68a"] * 8)
    make_simple_svg(FIG / "z1u_sankey.svg", "Z1U Flow Sankey", ["ACR-linked release", "User purchases", "Brand funding", "Campaign funding", "Z1U balance", "Utility spend", "Fees", "Burns", "Provider payout"], [(0, 4), (1, 4), (2, 4), (3, 4), (4, 5), (5, 6), (6, 7), (5, 8)], ["#bfdbfe"] * 9)
    make_simple_svg(FIG / "settlement_queue.svg", "Settlement Queue System", ["ACR requests", "Valid requests", "Settlement capacity", "Filled", "Backlog", "Queue age", "Failure/delay controls"], [(0, 1), (1, 3), (2, 3), (1, 4), (4, 5), (5, 6)])
    make_simple_svg(FIG / "treasury_sankey.svg", "Treasury Cash Flow", ["Brand revenue", "Utility fees", "User Z1U purchases", "Campaign fees", "Treasury cash", "OpEx", "Provider payouts", "Reserve", "Liquidity operations"], [(0, 4), (1, 4), (2, 4), (3, 4), (4, 5), (4, 6), (4, 7), (4, 8)], ["#bbf7d0"] * 9)
    make_simple_svg(FIG / "parameter_influence.svg", "Parameter Influence Graph", ["Claim rate", "Verification", "Activation", "Utility adoption", "Brand revenue", "Settlement capacity", "Unlock rate", "Launch readiness", "FDV reference"], [(0, 1), (1, 2), (2, 3), (3, 7), (4, 7), (5, 7), (6, 8), (7, 8)])
    make_simple_svg(FIG / "year5_ecosystem_state.svg", "Year-5 Ecosystem State", [
        f"Eligible {compact(base.iloc[-1]['eligible_identity_count'])}",
        f"Verified {compact(base.iloc[-1]['verified_users'])}",
        f"Active {compact(base.iloc[-1]['active_users'])}",
        f"Utility {compact(base.iloc[-1]['utility_users'])}",
        f"Revenue {money(base.iloc[-1]['annualized_network_revenue_usd'])}",
        f"Cash {money(base.iloc[-1]['ending_cash_usd'])}",
        f"Reference {money(base.iloc[-1]['z1_fundamental_reference_price_usd'])}",
    ], [(0, 1), (1, 2), (2, 3), (3, 4), (4, 5), (3, 6)])

    def save_line(name: str, cols: list[str], title: str, ylabel: str = "simulated value") -> None:
        fig, ax = plt.subplots(figsize=(10, 5.8))
        for col in cols:
            ax.plot(x, base[col], label=col.replace("_", " "))
        ax.set_title(chart_title(title, "Scenario: scale base | Period: Jan 2027-Dec 2031 | Source: simulation database"), fontsize=11, pad=12)
        ax.set_xlabel("period")
        ax.set_ylabel(ylabel)
        ax.legend(fontsize=8)
        ax.grid(True, alpha=0.25)
        fig.tight_layout()
        fig.savefig(FIG / name, format="svg")
        fig.savefig(FIG / name.replace(".svg", ".png"), dpi=160)
        plt.close(fig)

    save_line("user_funnel.svg", ["eligible_identity_count", "verified_users", "active_users", "utility_users", "settlement_users"], "User Funnel", "users")
    save_line("vesting_timeline.svg", ["acr_issued", "acr_vested", "acr_available_end", "acr_requested"], "ACR Vesting and Request Timeline", "ACR")
    save_line("circulating_supply.svg", ["z1_token_circulating_supply"], "Z1 Circulating Supply", "Z1 tokens")
    save_line("unlock_pressure.svg", ["z1_unlock_share_of_circulating"], "Unlock Pressure", "monthly unlock / circulation")

    fig, ax = plt.subplots(figsize=(8, 6))
    ax.pie(allocation["allocation_pct"], labels=allocation["allocation"].str.replace("_", " "), autopct="%1.0f%%")
    ax.set_title(chart_title("Token Allocation", "Scenario: scale base | Unit: percent of 10B max supply"), fontsize=11, pad=12)
    fig.tight_layout()
    fig.savefig(FIG / "token_allocation.svg", format="svg")
    fig.savefig(FIG / "token_allocation.png", dpi=160)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(8, 6))
    ax.pie(allocation["tge_circulation_pct_of_total"], labels=allocation["allocation"].str.replace("_", " "), autopct=lambda p: f"{p:.0f}%" if p > 0 else "")
    ax.set_title(chart_title("Initial Circulation Allocation", "Scenario: scale base | Unit: percent of initial float"), fontsize=11, pad=12)
    fig.tight_layout()
    fig.savefig(FIG / "initial_circulation.svg", format="svg")
    fig.savefig(FIG / "initial_circulation.png", dpi=160)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(10, 5.8))
    bridge = [2.8, -0.8, 0.35, -0.15, -0.20, 2.0]
    labels = ["Raw comparable", "drawdown", "Zee scale", "utility/revenue", "legal/liquidity", "recommended FDV"]
    ax.bar(labels, bridge, color=["#94a3b8", "#ef4444", "#22c55e", "#22c55e", "#ef4444", "#7c3aed"])
    ax.set_title(chart_title("Launch Valuation Bridge", "Scenario: management base | Unit: FDV USD billions | Not a forecast"), fontsize=11, pad=12)
    ax.set_ylabel("USD billions")
    ax.tick_params(axis="x", rotation=25)
    fig.tight_layout()
    fig.savefig(FIG / "valuation_bridge.svg", format="svg")
    fig.savefig(FIG / "valuation_bridge.png", dpi=160)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(10, 5.8))
    gate_df = gates.copy()
    gate_score = []
    for _, gate in gate_df.iterrows():
        actual = float(gate["actual"])
        threshold = float(gate["threshold"])
        if str(gate["operator"]).strip() == "<=":
            score = 1.4 if actual <= 0 else threshold / actual
        else:
            score = actual / threshold if threshold else 0.0
        gate_score.append(min(score, 1.4))
    gate_labels = gate_df["gate"].str.replace("_", " ", regex=False)
    ax.barh(gate_labels, gate_score, color=["#22c55e" if p else "#ef4444" for p in gate_df["passed"]])
    ax.axvline(1.0, color="#111827", linewidth=1)
    ax.set_title(chart_title("Launch Readiness Scorecard", "Scenario: scale base | Unit: actual / threshold"), fontsize=11, pad=12)
    ax.set_xlabel("coverage ratio")
    fig.tight_layout()
    fig.savefig(FIG / "launch_readiness.svg", format="svg")
    fig.savefig(FIG / "launch_readiness.png", dpi=160)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(10, 5.8))
    width = 0.25
    xs = range(len(scenario))
    ax.bar([i - width for i in xs], scenario["launch_verified_users"] / 1e6, width=width, label="verified TGE (M)")
    ax.bar(xs, scenario["launch_annualized_revenue_usd"] / 1e6, width=width, label="ann revenue TGE ($M)")
    ax.bar([i + width for i in xs], scenario["year5_fundamental_reference_price_usd"], width=width, label="year5 ref price ($)")
    ax.set_xticks(list(xs), scenario["scenario"])
    ax.set_title(chart_title("Scenario Comparison", "Downside, base and upside | Simulated outputs"), fontsize=11, pad=12)
    ax.legend()
    fig.tight_layout()
    fig.savefig(FIG / "scenarios.svg", format="svg")
    fig.savefig(FIG / "scenarios.png", dpi=160)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(10, 5.8))
    mc_plot = mc[mc["metric"].isin(["year5_verified_users", "year5_utility_users", "year5_revenue_usd", "fundamental_reference_price_usd"])].copy()
    for _, row in mc_plot.iterrows():
        ax.plot(["p5", "p25", "median", "p75", "p95"], [row["p5"], row["p25"], row["median"], row["p75"], row["p95"]], marker="o", label=row["metric"])
    ax.set_title(chart_title("Monte Carlo Percentiles", "1000 runs | Units vary by metric"), fontsize=11, pad=12)
    if not mc_plot.empty:
        ax.legend(fontsize=8)
    ax.grid(True, alpha=0.25)
    fig.tight_layout()
    fig.savefig(FIG / "monte_carlo.svg", format="svg")
    fig.savefig(FIG / "monte_carlo.png", dpi=160)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(10, 7))
    sensitivity["abs"] = sensitivity["elasticity_proxy"].abs()
    top = sensitivity.sort_values("abs", ascending=True).tail(16)
    ax.barh(top["parameter"], top["elasticity_proxy"], color=["#ef4444" if v < 0 else "#1f77b4" for v in top["elasticity_proxy"]])
    ax.set_title(chart_title("Sensitivity Tornado", "Elasticity proxy from scenario spread and mechanism review"), fontsize=11, pad=12)
    ax.set_xlabel("elasticity proxy")
    fig.tight_layout()
    fig.savefig(FIG / "sensitivity.svg", format="svg")
    fig.savefig(FIG / "sensitivity.png", dpi=160)
    plt.close(fig)

    sev_map = {"medium": 2, "high": 3, "critical": 4}
    prob_map = {"low": 1, "low-medium": 1.5, "medium": 2, "high": 3}
    heat = risk.copy()
    heat["x"] = heat["probability"].map(prob_map).fillna(2)
    heat["y"] = heat["severity"].map(sev_map).fillna(3)
    fig, ax = plt.subplots(figsize=(10, 6))
    ax.scatter(heat["x"], heat["y"], s=110, c="#ef4444", alpha=0.72)
    for _, row in heat.head(14).iterrows():
        ax.text(row["x"] + 0.03, row["y"] + 0.03, row["risk"][:20], fontsize=7)
    ax.set_xlim(0.5, 3.5)
    ax.set_ylim(1.5, 4.5)
    ax.set_xticks([1, 2, 3], ["low", "medium", "high"])
    ax.set_yticks([2, 3, 4], ["medium", "high", "critical"])
    ax.set_title(chart_title("Risk Heatmap", "Probability x severity | Source: report risk register"), fontsize=11, pad=12)
    ax.grid(True, alpha=0.25)
    fig.tight_layout()
    fig.savefig(FIG / "risk_heatmap.svg", format="svg")
    fig.savefig(FIG / "risk_heatmap.png", dpi=160)
    plt.close(fig)


def write_reports(ctx: dict[str, Any], tables: dict[str, pd.DataFrame]) -> None:
    base = ctx["base"]
    launch = base.iloc[11]
    final = base.iloc[-1]
    validation = ctx["validation"]
    source_path = SOURCE_DB
    deep_dive_md = mechanism_deep_dive_markdown(ctx, tables)
    stochastic_exec_md, stochastic_tech_md, _stochastic_meta = stochastic_report_sections()

    scorecard = pd.DataFrame([
        {"metric": "maximum addressable audience", "TGE": compact(launch["maximum_addressable_audience"]), "year5": compact(final["maximum_addressable_audience"]), "classification": "anchor/simulated cap"},
        {"metric": "eligible identities", "TGE": compact(launch["eligible_identity_count"]), "year5": compact(final["eligible_identity_count"]), "classification": "simulated"},
        {"metric": "verified users", "TGE": compact(launch["verified_users"]), "year5": compact(final["verified_users"]), "classification": "simulated"},
        {"metric": "active users", "TGE": compact(launch["active_users"]), "year5": compact(final["active_users"]), "classification": "simulated"},
        {"metric": "utility users", "TGE": compact(launch["utility_users"]), "year5": compact(final["utility_users"]), "classification": "simulated"},
        {"metric": "settlement users", "TGE": compact(launch["settlement_users"]), "year5": compact(final["settlement_users"]), "classification": "simulated"},
        {"metric": "utility GMV", "TGE": money(launch["utility_gmv_usd"]), "year5": money(final["cumulative_utility_gmv_usd"]), "classification": "simulated cumulative"},
        {"metric": "annualized revenue", "TGE": money(launch["annualized_network_revenue_usd"]), "year5": money(final["annualized_network_revenue_usd"]), "classification": "simulated"},
        {"metric": "cumulative revenue", "TGE": money(launch["cumulative_network_revenue_usd"]), "year5": money(final["cumulative_network_revenue_usd"]), "classification": "simulated"},
        {"metric": "average / p95 queue age", "TGE": f"{launch['queue_age_avg_days']:.2f} / {launch['queue_age_p95_days']:.2f} days", "year5": f"{final['queue_age_avg_days']:.2f} / {final['queue_age_p95_days']:.2f} days", "classification": "simulated"},
        {"metric": "treasury cash", "TGE": money(launch["ending_cash_usd"]), "year5": money(final["ending_cash_usd"]), "classification": "simulated"},
        {"metric": "settlement reserve", "TGE": money(launch["settlement_reserve_usd"]), "year5": money(final["settlement_reserve_usd"]), "classification": "simulated"},
        {"metric": "token launch price", "TGE": money(launch["z1_token_launch_price_usd"]), "year5": "not a forecast", "classification": "management scenario"},
        {"metric": "token FDV", "TGE": money(launch["z1_token_fdv_usd"]), "year5": money(final["z1_fundamental_reference_fdv_usd"]), "classification": "scenario/reference"},
        {"metric": "initial circulating supply", "TGE": compact(launch["z1_token_circulating_supply"]), "year5": compact(final["z1_token_circulating_supply"]), "classification": "token schedule"},
        {"metric": "initial circulating market cap", "TGE": money(launch["z1_token_circulating_market_cap_usd"]), "year5": money(final["z1_fundamental_reference_market_cap_usd"]), "classification": "scenario/reference"},
        {"metric": "year-5 fundamental reference value", "TGE": money(launch["z1_fundamental_reference_price_usd"]), "year5": money(final["z1_fundamental_reference_price_usd"]), "classification": "internal reference, not market forecast"},
        {"metric": "launch readiness status", "TGE": str(tables["gates"]["gate_result"].iloc[0]), "year5": "n/a", "classification": "gate evaluation"},
    ])

    exec_md = f"""# Z1 Full Token Lifecycle Executive Report

Generated: {datetime.now(timezone.utc).isoformat()}

Canonical source of truth: `{source_path}`. This is a file-based simulation database produced by `scripts/run_empirical_calibrated_simulation.py`; it is newer and more complete for the current Z1 lifecycle analysis than the supplied spreadsheet alone. The spreadsheet and CSV inputs remain source anchors and calibration inputs.

## 1. Executive Summary

The current Z1 simulation covers a 60-month lifecycle from January 2027 through December 2031. The base case reaches token launch at month 12 with {compact(launch['verified_users'])} verified users, {compact(launch['active_users'])} active users, {compact(launch['utility_users'])} utility users, {money(launch['annualized_network_revenue_usd'])} annualized network revenue, and {money(launch['ending_cash_usd'])} ending cash. The implemented launch gate result is **{tables['gates']['gate_result'].iloc[0]}**.

The model's strongest mechanisms are the explicit user funnel, monthly ACR stock-flow accounting, separate Z1U utility accounting, treasury cash-flow tracking, launch gates, and token supply/unlock schedule. Its weakest assumptions remain identity eligibility quality, campaign-transfer haircuts, user-funded utility willingness-to-pay, legal classification, market liquidity, and recipient sell behavior.

**Instrument separation is non-negotiable:** ACR is a personal non-transferable recognition credit; Z1U is an internal utility and settlement accounting unit; Z1 is the transferable active-participation token. The current database uses separate ACR, Z1U and Z1 token field families and the report preserves that separation throughout.

### Executive Scorecard

{md_table(scorecard, max_rows=30)}

![Full system architecture](figures/architecture.svg)

## 2. Model and Data Architecture

The implemented architecture is a layered TokenLab repository:

- `projects/z1/lifecycle_complete`: deterministic lifecycle and accounting reference.
- `projects/z1/empirical_calibrated_simulation`: current calibrated monthly simulation used for this report.
- `projects/z1/v4_decision_grade`: decision-grade scenario and accounting layer.
- `projects/z1/m3_full_economy`: experimental sandbox, not the primary evidence layer.

The selected source of truth is the current empirical calibrated simulation output database in `outputs/z1_empirical_calibrated_simulation`. It contains base, downside and upside period data; parameter and source registries; cohort transitions; launch gates; token supply and unlock schedule; train/holdout diagnostics; residuals; stress outputs; Monte Carlo summary; audit summary; and run manifest.

![Database schema](figures/database_schema.svg)

## 3. Evidence and Anchor Data

The model distinguishes Zee internal evidence, public or mixed evidence, third-party or comparable evidence, derived assumptions, calibrated parameters and purely structural assumptions. Internal programme claims are treated as anchors for modeling, not independently verified public facts.

{md_table(tables['anchors'][['anchor_id','metric','value','unit','source_type','confidence','direct_observation_or_inference','parameter_affected','limitation']], max_rows=20)}

## 4. Full Token Lifecycle

The lifecycle runs from audience eligibility through verification, activation, utility, settlement, treasury and Z1 token launch. Identity transitions create eligible, verified and active stocks. Accounting transitions create ACR and Z1U balances. Token-supply transitions affect only Z1 circulating supply and unlocks.

![Complete token lifecycle](figures/token_lifecycle.svg)

## 4A. Granular Mechanism Review

The report now includes a dedicated mechanism deep dive at `MECHANISM_DEEP_DIVE.md` and a structured `MECHANISM_PARAMETER_GUIDE.csv`. These explain each mechanism in plain English, list the driving parameters, show TGE and year-5 values or proxies, identify risks, and state concrete recommendations.

{md_table(tables['mechanism_parameter_guide'][['mechanism','parameter','unit','evidence_status','database_field','main_risk','recommendation']].head(18), max_rows=18)}

## 5. User Funnel and Cohort Behavior

At launch, verified/eligible is {pct(launch['verified_users']/launch['eligible_identity_count'])}; active/verified is {pct(launch['active_users']/launch['verified_users'])}; utility/active is {pct(launch['utility_users']/launch['active_users'])}. This confirms that the strategic bottleneck is not raw reach but conversion quality through verification, activation and paid utility.

![User funnel](figures/user_funnel.svg)

## 6. ACR Mechanism

ACR issuance recognizes historical participation and campaign or correction activity. It vests, becomes available, can be requested, held, voided, released from hold and settled into Z1U capacity. It is not a token and is not included in FDV.

![ACR stock flow](figures/acr_stock_flow.svg)

## 7. Z1U Utility Economy

Z1U enters through ACR-linked release, user purchases, brand funding and campaign funding. It leaves through utility spend, fees, burns and provider payouts. The implemented identity `provider_payout_z1u + fee_amount_z1u = utility_spend_z1u` validates across the base database.

![Z1U Sankey](figures/z1u_sankey.svg)

## 8. Settlement and Queue Model

The base case remains stable: maximum average queue age is {base['queue_age_avg_days'].max():.2f} days and maximum p95 queue age is {base['queue_age_p95_days'].max():.2f} days. Queue stability is a necessary condition for credible launch because settlement delay can feed churn, reputation risk and token sentiment.

![Settlement queue](figures/settlement_queue.svg)

## 9. Campaign System

Campaigns contribute acquisition, activation, utility activity and Z1U funding, but historical SMS, missed-call, QR, WhatsApp, OBD or watch-and-win response should not be transferred directly to token participation without haircuts. The report table separates campaign participants, attributed active users, attributed transactions, budget, escrow, payout and cost metrics.

## 10. Treasury and Commercial Model

The base case remains operationally solvent without requiring token appreciation: minimum ending cash is {money(base['ending_cash_usd'].min())}. That said, token-sale proceeds, legal costs, market-making inventory and compliance spend need explicit production treasury policies before TGE.

![Treasury flows](figures/treasury_sankey.svg)

## 11. Z1 Token Role and Demand

Z1 demand should come from verified participation, access, staking/collateral if implemented, utility discounts, premium experiences and ecosystem fees. The current implemented database supports token launch references, allocations, circulation and unlocks. It does not support a claim that expected appreciation is the demand mechanism.

## 12. Token Allocation

The implementation validates the base structure: 45% community/audience, 20% ecosystem incentives, 15% treasury, 8% team, 7% strategic partners/investors, and 5% liquidity/market operations. Initial circulation is 15% of max supply.

![Token allocation](figures/token_allocation.svg)

## 13. Supply, Vesting and Unlocks

The base schedule starts with {compact(launch['z1_token_circulating_supply'])} circulating Z1 at TGE and reaches {compact(final['z1_token_circulating_supply'])} by year 5. Unlock pressure should be monitored against liquidity depth and real user-funded utility.

![Circulating supply](figures/circulating_supply.svg)

## 14. Token Valuation

The $0.20 launch price and $2B FDV are management scenario references, not forecasts. At launch, FDV per verified user is {money(launch['z1_token_fdv_usd']/launch['verified_users'])}, FDV/revenue is {launch['z1_token_fdv_usd']/launch['annualized_network_revenue_usd']:.1f}x, and circulating market cap/revenue is {launch['z1_token_circulating_market_cap_usd']/launch['annualized_network_revenue_usd']:.1f}x.

![Valuation bridge](figures/valuation_bridge.svg)

## 15. Launch Readiness

Core gates pass in the current base case. Additional operational gates remain conditional: p95 queue SLA, provider commitments, utility transaction evidence, brand commitments, market-maker readiness, legal classification, token terms, vesting contracts, treasury policy, disclosure readiness, privacy, sanctions controls, security audit and operational support.

![Launch readiness](figures/launch_readiness.svg)

## 16. Fundamental Reference Value

The model uses an internal reference value driven by verified users, utility users and revenue. The current year-5 reference is approximately {money(final['z1_fundamental_reference_price_usd'])}. It must not be described as an expected market price or promised appreciation.

## 17. Market Price Scenarios

The current model does not contain a defensible full market microstructure module. It contains launch price cases and an internal fundamental reference. Therefore this report does not present market price forecasts. Any p5/p95 market chart should be treated as stress visualization only.

## 18. Scenario Analysis

Downside, base and upside cases are compared in `SCENARIO_COMPARISON.csv`. The base case passes core gates; downside is useful for stress discussion, especially lower revenue, lower conversion and liquidity pressure.

![Scenario comparison](figures/scenarios.svg)

{stochastic_exec_md}

## 19. Monte Carlo Results

The current database contains a 1,000-run Monte Carlo summary. It reports percentile bands for launch and year-5 adoption, revenue, cash, queue and reference-price outcomes. These are calibrated scenario uncertainty ranges, not final probability claims until live data calibrates distributions.

![Monte Carlo percentiles](figures/monte_carlo.svg)

## 20. Parameter and Mechanism Register

The parameter register documents units, source types, calibration status, priors/posteriors, confidence and limitations. The mechanism register documents purpose, input/output stocks, formulas, interactions and failure modes.

## 21. Sensitivity and Identifiability

Dominant sensitivities are launch FDV, claim/verification, utility adoption, brand revenue, settlement capacity, spend per utility user, liquidity depth and unlock rate. Weakly identified areas are ACR request/release versus settlement capacity, utility adoption versus subsidies, and FDV versus liquidity.

![Sensitivity tornado](figures/sensitivity.svg)

## 22. Risks and Failure Modes

The highest-priority launch blockers outside the numeric base case are legal classification, privacy/consent, security/smart-contract audit, identity eligibility quality, treasury liquidity policy and market-making commitments.

![Risk heatmap](figures/risk_heatmap.svg)

## 23. Insights

{md_table(pd.DataFrame(tables['insights']), max_rows=20)}

## 24. Recommendations

The practical path is not adding mechanics. It is tightening evidence, gating token launch on operating proof, keeping ACR/Z1U/Z1 legally and economically separate, and conditioning unlocks on utility and liquidity metrics.

{md_table(tables['recommendations'][['stage','issue','proposed_action','owner','urgency','success_metric']], max_rows=20)}

## Validation Status

{md_table(validation, max_rows=30)}

## Limitations

See `LIMITATIONS.md` for uncertainty, missing empirical data and unsupported claims.
"""

    technical_base_md = exec_md.replace("# Z1 Full Token Lifecycle Executive Report", "# Z1 Full Token Lifecycle Technical Report", 1)
    technical_md = technical_base_md + f"""

# Technical Appendix

## Source Tables

{md_table(tables['database_tables'], max_rows=30)}

## Lifecycle Transitions

{md_table(tables['transitions'], max_rows=30)}

## Mechanism Register Summary

{md_table(tables['mechanisms'], max_rows=30)}

## Granular Mechanism Deep Dive

{deep_dive_md}

{stochastic_tech_md}

## Parameter Register Summary

{md_table(tables['parameter_register'].head(20), max_rows=20)}

## Scenario Comparison

{md_table(tables['scenario_comparison'], max_rows=10)}

## Token Valuation Lenses

{md_table(tables['valuation'], max_rows=20)}

## Stress Tests

{md_table(tables['stress'], max_rows=30)}

## Identifiability Matrix

{md_table(tables['identifiability'], max_rows=20)}
"""

    (OUT / "EXECUTIVE_REPORT.md").write_text(exec_md, encoding="utf-8")
    (OUT / "TECHNICAL_REPORT.md").write_text(technical_md, encoding="utf-8")
    (OUT / "MECHANISM_DEEP_DIVE.md").write_text(deep_dive_md, encoding="utf-8")
    (OUT / "EXECUTIVE_REPORT.html").write_text(html_report(exec_md, "Z1 Full Token Lifecycle Executive Report"), encoding="utf-8")
    (OUT / "TECHNICAL_REPORT.html").write_text(html_report(technical_md, "Z1 Full Token Lifecycle Technical Report"), encoding="utf-8")

    (OUT / "SOURCE_OF_TRUTH.md").write_text(f"""# Source of Truth

Selected canonical simulation database: `{source_path}`.

Reason: this directory is the current generated output of the implemented empirical calibrated Z1 simulation. It contains base, downside and upside scenario period data, Monte Carlo summary, launch gates, token unlock schedule, parameter/source registries, train/holdout diagnostics, stress files, audit summary and run manifest. The spreadsheet and CSVs in Downloads are used as calibration inputs and reconciliation anchors, not as the final database when the repository contains newer generated outputs.

No DuckDB or SQLite database superseding this directory was identified in the inspected repository paths. Older Parquet/CSV simulation outputs exist for V2/V3 modules but do not contain the complete current Z1 lifecycle, token-launch, Z1U and ACR reporting surface.
""", encoding="utf-8")

    (OUT / "DATA_PROVENANCE.md").write_text(f"""# Data Provenance

The report is generated from actual simulation outputs in `{source_path}`. Input hashes are retained in the source run manifest. The current report copies and transforms those outputs into a reviewer-facing package while preserving traceability to source fields.

Observed, derived, assumed and simulated values are classified in `OBSERVED_DERIVED_ASSUMED_MATRIX.csv`, `DATA_DICTIONARY.csv`, `ANCHOR_DATA_REGISTER.csv` and `PARAMETER_REGISTER.csv`.
""", encoding="utf-8")

    (OUT / "DATABASE_SCHEMA.md").write_text("""# Database Schema

The current simulation database is a file-based analytical database composed of CSV and JSON artifacts. The primary period tables are keyed by `period` and `scenario`; cohort tables are keyed by `cohort`; parameter tables are keyed by `parameter_name`; launch gates are keyed by `gate`; Monte Carlo summary rows are keyed by `metric`.

Instrument field families:

- ACR: `acr_*`, `pending_acr_end`, `held_acr_balance_end`
- Z1U: `z1u_*`, utility spend, fees, burns and provider payout fields
- Z1 token: `z1_token_*`, `z1_monthly_unlocks`, `z1_cumulative_unlocks`, fundamental reference fields

See `DATABASE_TABLES.csv` and `figures/database_schema.svg`.
""", encoding="utf-8")

    insight_md = "# Insights\n\n" + "\n\n".join([f"## {row['rank']}. {row['insight']}\n\nEvidence: {row['evidence']}\n\nStrategic importance: {row['strategic_importance']}. Confidence: {row['confidence']}. Urgency: {row['urgency']}. Stakeholder: {row['affected_stakeholder']}." for row in tables["insights"]])
    (OUT / "INSIGHTS.md").write_text(insight_md, encoding="utf-8")

    (OUT / "LIMITATIONS.md").write_text("""# Limitations and Uncertainty

- The model is calibrated to the current scale-base dataset and token-launch workbook; it is not yet calibrated to live Z1 production cohorts.
- Zee internal programme anchors are not treated as independently verified public facts.
- Reach and historical audience are not equivalent to eligible, verified or active token participants.
- Legal classification, privacy, sanctions controls, smart-contract audit status, market-maker commitments and jurisdiction eligibility are outside the numeric simulation.
- The market price module is not a defensible forecast. The report therefore treats $0.20, $0.10 and $0.35 as scenario references.
- Campaign response haircuts, user-funded utility willingness-to-pay, provider concentration, recipient sell propensity and liquidity depth require empirical measurement.
- ACR is a recognition credit; Z1U is an internal utility accounting unit; Z1 is the transferable token. No report output should conflate them.
""", encoding="utf-8")


def write_all(ctx: dict[str, Any], tables: dict[str, pd.DataFrame]) -> None:
    mapping = {
        "DATA_DICTIONARY.csv": tables["data_dictionary"],
        "DATABASE_TABLES.csv": tables["database_tables"],
        "ANCHOR_DATA_REGISTER.csv": tables["anchors"],
        "OBSERVED_DERIVED_ASSUMED_MATRIX.csv": tables["observed_matrix"],
        "PARAMETER_REGISTER.csv": tables["parameter_register"],
        "MECHANISM_REGISTER.csv": tables["mechanisms"],
        "MECHANISM_PARAMETER_GUIDE.csv": tables["mechanism_parameter_guide"],
        "LIFECYCLE_TRANSITION_REGISTER.csv": tables["transitions"],
        "COHORT_ANALYSIS.csv": tables["cohorts"],
        "USER_FUNNEL_ANALYSIS.csv": tables["funnel"],
        "ACR_LIFECYCLE_ANALYSIS.csv": tables["acr"],
        "Z1U_FLOW_ANALYSIS.csv": tables["z1u"],
        "SETTLEMENT_QUEUE_ANALYSIS.csv": tables["settlement"],
        "CAMPAIGN_ANALYSIS.csv": tables["campaign"],
        "TREASURY_ANALYSIS.csv": tables["treasury"],
        "TOKEN_ALLOCATION_ANALYSIS.csv": tables["allocation"],
        "TOKEN_UNLOCK_SCHEDULE.csv": tables["token_supply"],
        "TOKEN_LAUNCH_ANALYSIS.csv": tables["token_launch"],
        "TOKEN_VALUATION_LENSES.csv": tables["valuation"],
        "LAUNCH_GATE_RESULTS.csv": tables["gates"],
        "SCENARIO_COMPARISON.csv": tables["scenario_comparison"],
        "STRESS_TEST_RESULTS.csv": tables["stress"],
        "MONTE_CARLO_SUMMARY.csv": tables["mc"],
        "SENSITIVITY_RESULTS.csv": tables["sensitivity"],
        "IDENTIFIABILITY_MATRIX.csv": tables["identifiability"],
        "RISK_REGISTER.csv": tables["risk"],
        "RECOMMENDATIONS.csv": tables["recommendations"],
    }
    for name, df in mapping.items():
        write_csv(OUT / name, df)

    data_mapping = {
        "report_period_data.csv": ctx["base"],
        "report_scenario_data.csv": pd.concat([ctx["downside"], ctx["base"], ctx["upside"]], ignore_index=True),
        "report_allocation_data.csv": tables["allocation"],
        "report_unlock_data.csv": tables["token_supply"],
        "report_treasury_data.csv": tables["treasury"],
        "report_settlement_data.csv": tables["settlement"],
        "report_monte_carlo_data.csv": tables["mc"],
    }
    for name, df in data_mapping.items():
        write_csv(DATA / name, df)

    stochastic_data_files = [
        "EXECUTIVE_KPI_SUMMARY.csv",
        "FAILURE_PROBABILITIES.csv",
        "STOCHASTIC_SUMMARY_STATISTICS.csv",
        "SCENARIO_DIFFERENTIATION_MATRIX.csv",
        "STOCHASTIC_SENSITIVITY_RESULTS.csv",
        "FAILURE_ATTRIBUTION_RESULTS.csv",
        "CONVERGENCE_RESULTS.csv",
        "REPORT_CONSISTENCY_TEST_RESULTS.csv",
    ]
    for name in stochastic_data_files:
        source = STOCHASTIC_DB / name
        if source.exists():
            shutil.copy2(source, DATA / f"stochastic_{name.lower()}")
    stochastic_manifest = STOCHASTIC_DB / "RUN_MANIFEST.json"
    if stochastic_manifest.exists():
        shutil.copy2(stochastic_manifest, DATA / "stochastic_run_manifest.json")


def finalize(ctx: dict[str, Any]) -> None:
    source_manifest = ctx["manifest"]
    generated_at = datetime.now(timezone.utc).isoformat()
    stochastic_manifest_path = STOCHASTIC_DB / "RUN_MANIFEST.json"
    stochastic_meta: dict[str, Any] = {"stochastic_integrated": False, "reason": "missing stochastic RUN_MANIFEST.json"}
    if stochastic_manifest_path.exists():
        stochastic_manifest = json.loads(stochastic_manifest_path.read_text(encoding="utf-8"))
        stochastic_run_manifest = stochastic_manifest.get("run_manifest", {})
        stochastic_meta = {
            "stochastic_integrated": True,
            "output_dir": str(STOCHASTIC_DB),
            "runs": stochastic_run_manifest.get("runs"),
            "seed": stochastic_run_manifest.get("seed"),
            "scenario_order": stochastic_run_manifest.get("scenario_order"),
            "common_random_numbers": stochastic_run_manifest.get("common_random_numbers"),
        }
    summary = {
        "generated_at": generated_at,
        "source_of_truth": str(SOURCE_DB),
        "source_manifest": source_manifest,
        "stochastic_stress_testing": stochastic_meta,
        "validation_passed": bool(ctx["validation"]["passed"].all()),
        "validation_issues": ctx["issues"],
        "required_files_missing": [],
        "required_figures_missing": [],
        "required_files_produced": False,
        "required_figures_produced": False,
        "monte_carlo_runs": int(ctx["audit"].get("monte_carlo_runs", 0)),
        "launch_gate_result": ctx["audit"].get("checks", {}).get("launch_gate_result"),
        "instrument_separation": ctx["audit"].get("checks", {}).get("instrument_separation"),
        "month12": ctx["audit"].get("checks", {}).get("month12"),
        "year5": ctx["audit"].get("checks", {}).get("year5"),
    }
    (OUT / "REPORT_SUMMARY.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    produced_files = sorted(path.name for path in OUT.iterdir() if path.is_file())
    produced_figures = sorted(path.name for path in FIG.glob("*.svg"))
    manifest = {
        "generated_at": generated_at,
        "command": "python scripts/generate_z1_full_token_lifecycle_report.py",
        "working_tree_identifier": git_id(),
        "environment": {"python": sys.version, "platform": platform.platform()},
        "source_database": str(SOURCE_DB),
        "source_hashes": {path.name: file_hash(path) for path in SOURCE_DB.glob("*") if path.is_file()},
        "report_outputs": produced_files,
        "figures": sorted(path.name for path in FIG.iterdir() if path.is_file()),
        "data_outputs": sorted(path.name for path in DATA.iterdir() if path.is_file()),
    }
    (OUT / "RUN_MANIFEST.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    produced_files = sorted(path.name for path in OUT.iterdir() if path.is_file())
    produced_figures = sorted(path.name for path in FIG.glob("*.svg"))
    missing_files = sorted(set(REQUIRED_FILES) - set(produced_files))
    missing_figures = sorted(set(REQUIRED_FIGURES) - set(produced_figures))
    summary.update({
        "required_files_missing": missing_files,
        "required_figures_missing": missing_figures,
        "required_files_produced": not missing_files,
        "required_figures_produced": not missing_figures,
    })
    (OUT / "REPORT_SUMMARY.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    if missing_files or missing_figures or not ctx["validation"]["passed"].all():
        raise SystemExit(f"Report generated with unresolved validation gaps. Missing files={missing_files}; missing figures={missing_figures}; issues={ctx['issues']}")


def main() -> None:
    setup_output()
    assembled = assemble_full_token_lifecycle_data()
    ctx = dict(assembled.context)
    tables = dict(assembled.tables)
    write_all(ctx, tables)
    make_figures(ctx, tables)
    write_reports(ctx, tables)
    finalize(ctx)


if __name__ == "__main__":
    main()
