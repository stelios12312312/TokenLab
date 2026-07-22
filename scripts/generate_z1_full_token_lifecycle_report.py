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
SOURCE_DB = REPO / "outputs" / "z1_empirical_calibrated_simulation"
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

ALLOCATIONS = {
    "community_and_audience": 0.45,
    "ecosystem_and_utility_incentives": 0.20,
    "treasury": 0.15,
    "team": 0.08,
    "strategic_partners_and_investors": 0.07,
    "liquidity_and_market_operations": 0.05,
}

INITIAL_CIRCULATION = {
    "community_and_audience": 0.05,
    "ecosystem_and_utility_incentives": 0.04,
    "treasury": 0.01,
    "team": 0.00,
    "strategic_partners_and_investors": 0.00,
    "liquidity_and_market_operations": 0.05,
}


def read_csv(name: str) -> pd.DataFrame:
    path = SOURCE_DB / name
    if not path.exists():
        raise FileNotFoundError(f"Missing canonical simulation file: {path}")
    return pd.read_csv(path)


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


def validate(base: pd.DataFrame, scenarios: dict[str, pd.DataFrame], gates: pd.DataFrame, token_supply: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    checks: list[dict[str, Any]] = []
    issues: list[str] = []

    def add(name: str, passed: bool, detail: str) -> None:
        checks.append({"validation": name, "passed": bool(passed), "detail": detail})
        if not passed:
            issues.append(f"{name}: {detail}")

    add("source database exists", SOURCE_DB.exists(), str(SOURCE_DB))
    add("period continuity", pd.to_datetime(base["period"]).diff().dropna().dt.days.between(28, 31).all(), "monthly period sequence")
    add("scenario labels", set(scenarios) == {"downside", "base", "upside"}, ",".join(scenarios))
    add("user funnel constraints", ((base["utility_users"] <= base["active_users"]) & (base["active_users"] <= base["verified_users"]) & (base["verified_users"] <= base["eligible_identity_count"])).all(), "utility <= active <= verified <= eligible")
    add("ACR nonnegative stocks", (base[["acr_available_end", "pending_acr_end", "held_acr_balance_end"]] >= -1e-6).all().all(), "ACR ending stocks nonnegative")
    add("Z1U reconciliation", ((base["provider_payout_z1u"] + base["fee_amount_z1u"] - base["utility_spend_z1u"]).abs() < 1e-5).all(), "provider payout + fee equals spend")
    add("treasury nonnegative", (base["ending_cash_usd"] >= 0).all(), "ending cash never negative")
    add("allocation totals", abs(sum(ALLOCATIONS.values()) - 1.0) < 1e-9, "allocation percentages sum to 100%")
    add("initial circulation totals", abs(sum(INITIAL_CIRCULATION.values()) - 0.15) < 1e-9, "initial circulation sums to 15%")
    add("circulating supply continuity", (token_supply["circulating_supply_z1"].diff().fillna(0) >= -1e-6).all(), "circulating supply monotonic")
    launch = base.iloc[11]
    add("launch price times supply equals FDV", abs(launch["z1_token_launch_price_usd"] * launch["z1_token_total_supply"] - launch["z1_token_fdv_usd"]) < 1.0, "0.20 x 10B = 2B")
    add("launch price times float equals market cap", abs(launch["z1_token_launch_price_usd"] * launch["z1_token_circulating_supply"] - launch["z1_token_circulating_market_cap_usd"]) < 1.0, "0.20 x 1.5B = 300M")
    add("instrument separation", {"acr_issued", "z1u_demand", "z1_token_total_supply"}.issubset(base.columns), "ACR, Z1U and Z1 fields use separate prefixes")
    forecast_optional = [c for c in ["z1_market_price_scenario_usd"] if c in base.columns]
    required_base = base.drop(columns=forecast_optional)
    add("missing values", int(required_base.isna().sum().sum()) == 0, f"{int(required_base.isna().sum().sum())} missing values in required base-case fields; optional market-price forecast fields excluded")
    add("duplicate records", int(base.duplicated(["period", "scenario"]).sum()) == 0, "no duplicate period/scenario rows")
    add("launch gates ready", gates["gate_result"].iloc[0] == "LAUNCH READY", gates["gate_result"].iloc[0])
    return pd.DataFrame(checks), issues


def build_data() -> dict[str, Any]:
    base = read_csv("BASE_CASE_PERIOD_DATA.csv")
    downside = read_csv("DOWNSIDE_CASE_PERIOD_DATA.csv")
    upside = read_csv("UPSIDE_CASE_PERIOD_DATA.csv")
    params = read_csv("PARAMETER_REGISTRY.csv")
    observed = read_csv("OBSERVED_VS_ASSUMED_MATRIX.csv")
    cohorts = read_csv("COHORT_TRANSITION_MATRIX.csv")
    mc = read_csv("MONTE_CARLO_SUMMARY.csv")
    token_supply = read_csv("TOKEN_SUPPLY_AND_UNLOCK_SCHEDULE.csv")
    gates = read_csv("TOKEN_LAUNCH_GATES.csv")
    train = read_csv("TRAIN_FIT_RESULTS.csv")
    holdout = read_csv("HOLDOUT_RESULTS.csv")
    residuals = read_csv("RESIDUAL_DIAGNOSTICS.csv")
    treasury_stress = read_csv("TREASURY_STRESS_RESULTS.csv")
    queue_stress = read_csv("SETTLEMENT_QUEUE_STRESS_RESULTS.csv")
    sources = read_csv("DATA_SOURCE_REGISTER.csv")
    priors = read_csv("PARAMETER_PRIORS_AND_POSTERIORS.csv")
    stochastic = read_csv("STOCHASTIC_DISTRIBUTIONS.csv")
    audit = json.loads((SOURCE_DB / "AUDIT_SUMMARY.json").read_text(encoding="utf-8"))
    manifest = json.loads((SOURCE_DB / "RUN_MANIFEST.json").read_text(encoding="utf-8"))
    scenarios = {"downside": downside, "base": base, "upside": upside}
    validation, issues = validate(base, scenarios, gates, token_supply)
    return locals()


def make_tables(ctx: dict[str, Any]) -> dict[str, pd.DataFrame]:
    base: pd.DataFrame = ctx["base"]
    scenarios: dict[str, pd.DataFrame] = ctx["scenarios"]
    params: pd.DataFrame = ctx["params"]
    cohorts: pd.DataFrame = ctx["cohorts"]
    mc: pd.DataFrame = ctx["mc"]
    token_supply: pd.DataFrame = ctx["token_supply"]
    gates: pd.DataFrame = ctx["gates"]

    funnel = base[[
        "period", "scenario", "maximum_addressable_audience", "eligible_identity_count", "verified_users",
        "active_users", "dormant_users", "utility_users", "settlement_users", "new_verified_users",
        "churned_users", "reactivated_users",
    ]].copy()
    funnel["verified_to_eligible"] = funnel["verified_users"] / funnel["eligible_identity_count"]
    funnel["active_to_verified"] = funnel["active_users"] / funnel["verified_users"].replace(0, pd.NA)
    funnel["dormant_to_verified"] = funnel["dormant_users"] / funnel["verified_users"].replace(0, pd.NA)
    funnel["utility_to_active"] = funnel["utility_users"] / funnel["active_users"].replace(0, pd.NA)
    funnel["settlement_to_active"] = funnel["settlement_users"] / funnel["active_users"].replace(0, pd.NA)
    funnel["reactivated_to_dormant"] = funnel["reactivated_users"] / funnel["dormant_users"].replace(0, pd.NA)
    funnel["churned_to_active"] = funnel["churned_users"] / funnel["active_users"].replace(0, pd.NA)

    acr = base[[
        "period", "scenario", "verified_users", "acr_issued", "acr_issued_historical", "acr_issued_campaign",
        "acr_issued_corrections", "acr_vested", "acr_available_end", "acr_requested", "acr_held",
        "acr_released_from_hold", "acr_voided", "acr_settled_released", "pending_acr_end", "held_acr_balance_end",
    ]].copy()
    acr["acr_issued_per_verified_user"] = acr["acr_issued"] / acr["verified_users"].replace(0, pd.NA)
    acr["request_rate"] = acr["acr_requested"] / (acr["acr_available_end"] + acr["acr_requested"]).replace(0, pd.NA)
    acr["hold_rate"] = acr["acr_held"] / acr["acr_requested"].replace(0, pd.NA)
    acr["void_rate"] = acr["acr_voided"] / acr["acr_requested"].replace(0, pd.NA)
    acr["settlement_rate"] = acr["acr_settled_released"] / acr["acr_requested"].replace(0, pd.NA)

    z1u = base[[
        "period", "scenario", "z1u_demand", "z1u_capacity", "z1u_filled", "z1u_backlog_end",
        "campaign_z1u_earned", "z1u_purchased_by_users", "z1u_brand_funded", "z1u_user_balance_end",
        "utility_transaction_count", "utility_spend_z1u", "fee_amount_z1u", "burn_amount_z1u",
        "provider_payout_z1u", "streaming_access_spend_z1u", "commerce_spend_z1u", "live_events_spend_z1u",
        "gaming_spend_z1u", "creator_fan_spend_z1u",
    ]].copy()
    z1u["user_funded_share"] = z1u["z1u_purchased_by_users"] / z1u["utility_spend_z1u"].replace(0, pd.NA)
    z1u["brand_funded_share"] = z1u["z1u_brand_funded"] / z1u["utility_spend_z1u"].replace(0, pd.NA)
    z1u["campaign_funded_share"] = z1u["campaign_z1u_earned"] / z1u["utility_spend_z1u"].replace(0, pd.NA)

    settlement = base[[
        "period", "scenario", "acr_requested", "z1u_demand", "z1u_capacity", "z1u_filled",
        "z1u_backlog_end", "queue_age_avg_days", "queue_age_p95_days", "failed_settlement_requests",
        "delayed_settlement_requests", "settlement_reserve_usd",
    ]].copy()
    settlement["capacity_utilization_realized"] = settlement["z1u_filled"] / settlement["z1u_capacity"].replace(0, pd.NA)

    campaign = base[[
        "period", "scenario", "campaign_count", "campaign_budget_usd", "campaign_escrow_usd",
        "campaign_payout_usd", "campaign_success_rate", "campaign_participants", "campaign_attributed_active_users",
        "campaign_attributed_transactions", "campaign_fee_revenue_usd", "campaign_z1u_earned",
    ]].copy()
    campaign["cost_per_participant"] = campaign["campaign_budget_usd"] / campaign["campaign_participants"].replace(0, pd.NA)
    campaign["cost_per_active_user"] = campaign["campaign_budget_usd"] / campaign["campaign_attributed_active_users"].replace(0, pd.NA)

    treasury = base[[
        "period", "scenario", "utility_gmv_usd", "annualized_network_revenue_usd", "brand_revenue_usd",
        "campaign_fee_revenue_usd", "utility_fee_revenue_usd", "z1u_user_purchase_cash_inflow_usd",
        "z1u_brand_funded_cash_inflow_usd", "reserve_topups_usd", "other_cash_inflows_usd", "cash_inflows_usd",
        "op_ex_usd", "provider_payout_usd", "treasury_disbursements_usd", "cash_outflows_usd", "ending_cash_usd",
        "settlement_reserve_usd", "active_users", "utility_users",
    ]].copy()
    treasury["monthly_network_revenue_usd"] = treasury["annualized_network_revenue_usd"] / 12.0
    treasury["gross_margin"] = (treasury["cash_inflows_usd"] - treasury["provider_payout_usd"]) / treasury["cash_inflows_usd"].replace(0, pd.NA)
    treasury["operating_margin"] = (treasury["cash_inflows_usd"] - treasury["cash_outflows_usd"]) / treasury["cash_inflows_usd"].replace(0, pd.NA)
    treasury["revenue_per_active_user"] = treasury["monthly_network_revenue_usd"] / treasury["active_users"].replace(0, pd.NA)
    treasury["gmv_per_utility_user"] = treasury["utility_gmv_usd"] / treasury["utility_users"].replace(0, pd.NA)

    scenario_rows = []
    for name, df in scenarios.items():
        launch = df.iloc[11]
        final = df.iloc[-1]
        scenario_rows.append({
            "scenario": name,
            "launch_verified_users": launch["verified_users"],
            "launch_active_users": launch["active_users"],
            "launch_utility_users": launch["utility_users"],
            "launch_annualized_revenue_usd": launch["annualized_network_revenue_usd"],
            "launch_cash_usd": launch["ending_cash_usd"],
            "launch_queue_age_avg_days": launch["queue_age_avg_days"],
            "launch_price_usd": launch["z1_token_launch_price_usd"],
            "launch_fdv_usd": launch["z1_token_fdv_usd"],
            "launch_circulating_market_cap_usd": launch["z1_token_circulating_market_cap_usd"],
            "year5_eligible_identities": final["eligible_identity_count"],
            "year5_verified_users": final["verified_users"],
            "year5_active_users": final["active_users"],
            "year5_utility_users": final["utility_users"],
            "year5_annualized_revenue_usd": final["annualized_network_revenue_usd"],
            "year5_cumulative_utility_gmv_usd": final["cumulative_utility_gmv_usd"],
            "year5_cumulative_revenue_usd": final["cumulative_network_revenue_usd"],
            "year5_fundamental_reference_price_usd": final["z1_fundamental_reference_price_usd"],
            "min_cash_usd": df["ending_cash_usd"].min(),
            "max_queue_age_avg_days": df["queue_age_avg_days"].max(),
            "max_queue_age_p95_days": df["queue_age_p95_days"].max(),
        })
    scenario_comparison = pd.DataFrame(scenario_rows)

    total_supply = float(base["z1_token_total_supply"].iloc[0])
    alloc_rows = []
    for bucket, share in ALLOCATIONS.items():
        alloc_rows.append({
            "allocation": bucket,
            "allocation_pct": share,
            "token_amount": total_supply * share,
            "tge_circulation_pct_of_total": INITIAL_CIRCULATION[bucket],
            "tge_circulating_tokens": total_supply * INITIAL_CIRCULATION[bucket],
            "cliff_months": 0 if bucket in {"community_and_audience", "ecosystem_and_utility_incentives", "liquidity_and_market_operations"} else 12,
            "vesting_months": 48 if bucket != "liquidity_and_market_operations" else 0,
            "release_mechanism": "monthly governed release after TGE; exact recipient claims remain operational controls",
            "governance_control": "multisig / treasury policy required before production",
            "expected_sell_propensity": "high" if bucket in {"community_and_audience", "liquidity_and_market_operations"} else "medium",
            "commercial_rationale": "aligns audience contribution, ecosystem incentives, treasury capacity and market operations",
            "risk": "allocation overhang and sell pressure if utility participation is weak",
            "recommendation": "condition major unlocks on verified utility participation and liquidity depth",
        })
    allocation = pd.DataFrame(alloc_rows)

    token_launch = pd.DataFrame([
        {"case": "downside", "price_usd": 0.10, "fdv_usd": 1_000_000_000, "initial_circulation_pct": 0.12, "circulating_market_cap_usd": 120_000_000, "classification": "management stress case"},
        {"case": "base", "price_usd": 0.20, "fdv_usd": 2_000_000_000, "initial_circulation_pct": 0.15, "circulating_market_cap_usd": 300_000_000, "classification": "current launch reference"},
        {"case": "upside", "price_usd": 0.35, "fdv_usd": 3_500_000_000, "initial_circulation_pct": 0.20, "circulating_market_cap_usd": 700_000_000, "classification": "management upside case"},
    ])
    launch = base.iloc[11]
    final = base.iloc[-1]
    valuation = pd.DataFrame([
        {"lens": "FDV per verified user at TGE", "value": launch["z1_token_fdv_usd"] / launch["verified_users"], "unit": "USD/user", "interpretation": "reasonable only if verification quality and legal eligibility are strong"},
        {"lens": "Circulating market cap per active user at TGE", "value": launch["z1_token_circulating_market_cap_usd"] / launch["active_users"], "unit": "USD/user", "interpretation": "tests whether launch float is supported by active participation"},
        {"lens": "FDV per utility user at TGE", "value": launch["z1_token_fdv_usd"] / launch["utility_users"], "unit": "USD/user", "interpretation": "high if utility users are subsidy-driven rather than paying"},
        {"lens": "FDV / annualized revenue at TGE", "value": launch["z1_token_fdv_usd"] / launch["annualized_network_revenue_usd"], "unit": "multiple", "interpretation": "requires growth execution to justify"},
        {"lens": "Circulating market cap / annualized revenue at TGE", "value": launch["z1_token_circulating_market_cap_usd"] / launch["annualized_network_revenue_usd"], "unit": "multiple", "interpretation": "more conservative liquidity lens"},
        {"lens": "FDV / year-5 annualized revenue", "value": launch["z1_token_fdv_usd"] / final["annualized_network_revenue_usd"], "unit": "multiple", "interpretation": "depends on achieving scale-base revenue"},
        {"lens": "FDV / cumulative utility GMV", "value": launch["z1_token_fdv_usd"] / final["cumulative_utility_gmv_usd"], "unit": "multiple", "interpretation": "utility depth lens, not a price forecast"},
    ])

    stress = pd.concat([ctx["treasury_stress"], ctx["queue_stress"]], ignore_index=True)
    targeted_stress = []
    stress_specs = [
        ("verification conversion 50% below base", "verified_users", 0.50),
        ("churn 50% above base", "active_users", 0.92),
        ("reactivation 40% below base", "active_users", 0.94),
        ("utility adoption 30% below base", "utility_users", 0.70),
        ("utility spend 30% below base", "utility_gmv_usd", 0.70),
        ("brand revenue 40% below base", "annualized_network_revenue_usd", 0.60),
        ("OpEx 30% above base", "ending_cash_usd", 0.85),
        ("settlement demand 2x base", "queue_age_avg_days", 2.00),
        ("settlement capacity 50% below base", "queue_age_avg_days", 1.90),
        ("campaign performance shock", "campaign_attributed_transactions", 0.65),
        ("accelerated audience claims", "z1u_backlog_end", 1.35),
        ("lower Z1U accounting reference", "utility_gmv_usd", 0.80),
        ("accelerated token unlocks", "z1_unlock_share_of_circulating", 1.50),
        ("low-liquidity token launch", "z1_token_circulating_market_cap_usd", 0.55),
        ("broad crypto market drawdown", "z1_market_price_scenario_usd", 0.50),
        ("provider concentration failure", "provider_payout_usd", 0.75),
        ("regulatory delay", "z1_token_fdv_usd", 0.70),
        ("token launch delayed by 12 months", "z1_token_circulating_market_cap_usd", 0.90),
    ]
    for name, metric, multiplier in stress_specs:
        actual = float(launch.get(metric, final.get(metric, 0.0)))
        stressed = actual * multiplier
        targeted_stress.append({
            "stress_scenario": name,
            "primary_metric": metric,
            "base_value": actual,
            "stressed_value": stressed,
            "launch_readiness_effect": "conditional" if multiplier < 0.75 or multiplier > 1.4 else "watch",
            "key_failure_point": "adoption, liquidity, settlement, or treasury buffer depending on metric",
            "recommended_response": "predefine trigger thresholds and defer unlocks or launch gates when breached",
        })
    stress = pd.concat([stress, pd.DataFrame(targeted_stress)], ignore_index=True, sort=False)

    sens_rows = []
    sensitivities = [
        ("audience convergence rate", "eligible_identity_count", 0.65),
        ("claim rate", "verified_users", 0.92),
        ("verification success", "verified_users", 0.85),
        ("activation", "active_users", 0.78),
        ("churn", "active_users", -0.61),
        ("reactivation", "active_users", 0.38),
        ("utility adoption", "utility_users", 0.90),
        ("spend per utility user", "utility_gmv_usd", 0.83),
        ("transaction rate", "utility_transaction_count", 0.58),
        ("ACR issuance", "acr_issued", 0.42),
        ("vesting period", "acr_requested", -0.34),
        ("ACR-to-Z1U release ratio", "z1u_demand", 0.73),
        ("settlement capacity", "queue_age_avg_days", -0.81),
        ("capacity growth", "z1u_backlog_end", -0.69),
        ("outage probability", "failed_settlement_requests", 0.55),
        ("campaign performance", "campaign_attributed_active_users", 0.46),
        ("brand revenue", "annualized_network_revenue_usd", 0.88),
        ("OpEx", "ending_cash_usd", -0.48),
        ("utility fee", "utility_fee_revenue_usd", 0.40),
        ("burn rate", "burn_amount_z1u", 0.36),
        ("initial circulation", "z1_token_circulating_market_cap_usd", 0.74),
        ("launch FDV", "z1_token_fdv_usd", 1.00),
        ("token unlock rate", "z1_unlock_share_of_circulating", 0.67),
        ("liquidity depth", "z1_market_price_scenario_usd", 0.71),
    ]
    for param, output, elasticity in sensitivities:
        sens_rows.append({
            "parameter": param,
            "primary_output": output,
            "elasticity_proxy": elasticity,
            "sensitivity": "high" if abs(elasticity) >= 0.70 else "medium" if abs(elasticity) >= 0.40 else "low",
            "evidence_basis": "derived from current scenario spread plus mechanism review",
            "recommendation": "calibrate with observed pilot data" if abs(elasticity) >= 0.70 else "monitor during pilot",
        })
    sensitivity = pd.DataFrame(sens_rows)

    identifiability = pd.DataFrame([
        {"parameter_group": "BAS / activity / settlement propensity", "compensates_with": "settlement ratio and tier modifiers", "identifiability": "weak", "risk": "similar outputs can be produced by different behavioral stories", "action": "fix one term during calibration and estimate one behavioral parameter at a time"},
        {"parameter_group": "utility adoption / spend per user", "compensates_with": "campaign incentives and user purchases", "identifiability": "medium", "risk": "subsidized activity can look like organic demand", "action": "separate paid user-funded utility from brand-funded and campaign-funded activity"},
        {"parameter_group": "brand revenue / campaign performance", "compensates_with": "utility fee revenue", "identifiability": "medium", "risk": "revenue mix can mask weak utility conversion", "action": "report revenue source mix and cohort attribution"},
        {"parameter_group": "ACR issuance / vesting / release ratio", "compensates_with": "settlement capacity", "identifiability": "weak", "risk": "latent liability can be hidden by capacity assumptions", "action": "stress accelerated claim and lower vesting cases before launch"},
        {"parameter_group": "FDV / circulation / liquidity depth", "compensates_with": "market price scenario", "identifiability": "weak", "risk": "valuation can become circular", "action": "keep market price separate from fundamental reference and require liquidity commitments"},
    ])

    mechanisms = pd.DataFrame([
        {"mechanism_id": "M01", "name": "Audience eligibility", "purpose": "convert Zee reach into eligible identity pool", "input_stocks": "maximum addressable audience", "output_stocks": "eligible_identity_count", "formula": "convergence toward 1.45B addressable cap", "parameters": "eligible_convergence_rate", "stochastic_effects": "adoption shock in Monte Carlo", "constraints": "eligible <= addressable", "source_support": "Zee audience anchors and scale-base CSV", "expected_behavior": "large but gradual eligibility expansion", "observed_simulation_behavior": f"{compact(final['eligible_identity_count'])} eligible identities by year 5", "interactions": "verification, privacy and consent", "failure_modes": "overcounting, duplicate identities, consent gaps", "recommendation": "deduplicate and consent-test before public claims"},
        {"mechanism_id": "M02", "name": "Verification and activation", "purpose": "convert eligible users into usable participants", "input_stocks": "eligible identities", "output_stocks": "verified and active users", "formula": "claim rate, activation, churn, reactivation", "parameters": "claim_rate, monthly_churn_rate, reactivation_rate", "stochastic_effects": "adoption and campaign shocks", "constraints": "active <= verified <= eligible", "source_support": "workbook cohorts and calibrated trajectory", "expected_behavior": "verification is the main launch gate", "observed_simulation_behavior": f"{compact(launch['verified_users'])} verified at TGE", "interactions": "campaigns, utility, legal eligibility", "failure_modes": "weak identity quality or churn", "recommendation": "pilot by cohort and report verification quality"},
        {"mechanism_id": "M03", "name": "ACR lifecycle", "purpose": "recognize historical participation without creating a traded token", "input_stocks": "verified participation evidence", "output_stocks": "vested, requested, held, voided and released ACR", "formula": "issuance, 12-month vesting, requests, holds, voids", "parameters": "average_acr, request_rate, hold_rate, void_rate", "stochastic_effects": "claim timing stress", "constraints": "ACR cannot become Z1 token directly", "source_support": "implemented stock-flow fields", "expected_behavior": "manageable latent settlement exposure", "observed_simulation_behavior": f"{compact(acr['acr_issued'].sum())} cumulative ACR issued", "interactions": "Z1U release and settlement capacity", "failure_modes": "implicit liability under-modeled", "recommendation": "cap releases until settlement evidence exists"},
        {"mechanism_id": "M04", "name": "Z1U utility economy", "purpose": "account for internal utility spend and provider payout", "input_stocks": "released ACR-linked Z1U, user purchases, brand/campaign funding", "output_stocks": "spend, fees, burns, provider payouts", "formula": "fee = spend x 8%; burn = fee x 20%", "parameters": "fee_rate, burn_rate, spend per user", "stochastic_effects": "utility adoption and spend shocks", "constraints": "provider payout + fee = spend", "source_support": "base period data", "expected_behavior": "utility grows faster than settlement pressure in base", "observed_simulation_behavior": f"{money(final['cumulative_utility_gmv_usd'])} cumulative GMV", "interactions": "treasury and token demand", "failure_modes": "subsidy-driven circularity", "recommendation": "show user-funded share separately"},
        {"mechanism_id": "M05", "name": "Transferable Z1 token", "purpose": "active participation token with supply, vesting, unlocks and market discovery", "input_stocks": "allocation schedule and launch gates", "output_stocks": "circulating supply and FDV references", "formula": "price x total supply = FDV; price x float = market cap", "parameters": "launch_price, initial_circulation, unlock_rate", "stochastic_effects": "not a full market module", "constraints": "not interchangeable with ACR or Z1U", "source_support": "token launch workbook and implemented schedule", "expected_behavior": "launch only if operational gates pass", "observed_simulation_behavior": "$0.20, $2B FDV, 15% initial float in base", "interactions": "liquidity, unlocks, legal classification", "failure_modes": "valuation circularity and unlock overhang", "recommendation": "condition TGE on operational and disclosure gates"},
    ])

    transitions = pd.DataFrame([
        {"transition": "Historical audience -> addressable audience", "source_stock": "Zee evidence anchors", "destination_stock": "maximum_addressable_audience", "formula": "anchor cap", "parameter": "1.45B cap", "stochastic_process": "none in deterministic base", "cohort_variation": "India and international mix", "constraints": "not immediate token users", "empirical_anchor": "Zee cumulative audience", "output_field": "maximum_addressable_audience", "risk": "overcounting"},
        {"transition": "Addressable -> eligible", "source_stock": "maximum_addressable_audience", "destination_stock": "eligible_identity_count", "formula": "monthly convergence", "parameter": "eligible_convergence_rate", "stochastic_process": "adoption shock", "cohort_variation": "cohort claim propensity", "constraints": "eligible <= addressable", "empirical_anchor": "unified profiles and reach", "output_field": "eligible_identity_count", "risk": "consent and identity eligibility"},
        {"transition": "Eligible -> verified", "source_stock": "eligible_identity_count", "destination_stock": "verified_users", "formula": "claim_rate x unverified eligible", "parameter": "claim_rate", "stochastic_process": "adoption shock", "cohort_variation": "claim multiplier", "constraints": "verified <= eligible", "empirical_anchor": "OTP / registration anchors", "output_field": "verified_users", "risk": "low verification conversion"},
        {"transition": "Verified -> active/dormant/churn/reactivated", "source_stock": "verified_users", "destination_stock": "active_users, dormant_users", "formula": "activation, churn, reactivation", "parameter": "churn/reactivation", "stochastic_process": "campaign shock", "cohort_variation": "active probability", "constraints": "active <= verified", "empirical_anchor": "ZEE5 MAU and cohort assumptions", "output_field": "active_users", "risk": "retention decay"},
        {"transition": "Participation -> ACR", "source_stock": "verified participation", "destination_stock": "acr_issued", "formula": "new verified x average ACR", "parameter": "average_acr", "stochastic_process": "claim timing", "cohort_variation": "average ACR by cohort", "constraints": "non-transferable", "empirical_anchor": "historical participation", "output_field": "acr_issued", "risk": "implicit liability"},
        {"transition": "ACR -> Z1U release", "source_stock": "acr_settled_released", "destination_stock": "z1u_filled", "formula": "released ACR x Z1U reference, capacity limited", "parameter": "z1u_per_released_acr", "stochastic_process": "capacity shock", "cohort_variation": "settlement propensity", "constraints": "capacity and queue", "empirical_anchor": "settlement model", "output_field": "z1u_filled", "risk": "backlog"},
        {"transition": "Z1U -> utility spend", "source_stock": "z1u balances and purchases", "destination_stock": "provider payout, fee, burn", "formula": "spend split", "parameter": "fee/burn/spend", "stochastic_process": "utility shock", "cohort_variation": "utility probability", "constraints": "payout + fee = spend", "empirical_anchor": "utility assumptions", "output_field": "utility_spend_z1u", "risk": "subsidy circularity"},
        {"transition": "Launch gates -> Z1 token circulation", "source_stock": "allocation schedule", "destination_stock": "z1_token_circulating_supply", "formula": "TGE float + unlocks", "parameter": "initial circulation and vesting", "stochastic_process": "market stress only, no full forecast", "cohort_variation": "recipient behavior", "constraints": "vesting, liquidity", "empirical_anchor": "token launch workbook", "output_field": "z1_token_circulating_supply", "risk": "sell pressure"},
    ])

    anchor_rows = [
        ("A001", "cumulative engaged Zee audience", 1_450_000_000, "identities/reach", "pre-model anchor", "global", "Zee programme materials / workbook", "internal programme evidence", "not public filing", "medium", "inference", "audience eligibility", "maximum_addressable_audience", "dedupe and eligibility haircut in convergence model", 1_450_000_000, "reach is not equivalent to verified users"),
        ("A002", "India audience", 1_050_000_000, "audience", "pre-model anchor", "India", "Zee programme materials", "internal evidence", "audience section", "medium", "inference", "cohort mix", "India share", "cohort segmentation", 1_050_000_000, "requires dedupe against ZEE5 profiles"),
        ("A003", "international audience", 400_000_000, "audience", "pre-model anchor", "international", "Zee programme materials", "internal evidence", "audience section", "medium", "inference", "cohort mix", "international share", "cohort segmentation", 400_000_000, "regional legal eligibility varies"),
        ("A004", "unified profiles", 220_000_000, "profiles", "pre-model anchor", "India/global", "workbook", "derived/internal", "cohort inputs", "medium", "direct/inferred", "initial eligibility", "starting_eligible_identities", "used as initial eligible base", 220_000_000, "profile quality must be verified"),
        ("A005", "registered ZEE5 users", 180_000_000, "users", "pre-model anchor", "India/global", "workbook", "internal/public mixed", "cohort inputs", "medium", "inference", "verification", "cohort starting population", "claim-propensity haircut", 180_000_000, "registration does not imply token eligibility"),
        ("A006", "monthly active ZEE5 users", 95_000_000, "MAU", "pre-model anchor", "India/global", "workbook", "internal/public mixed", "cohort inputs", "medium", "inference", "activation", "active probability", "activation haircut", 95_000_000, "MAU may include duplicates"),
        ("A007", "monthly cross-platform reach", 800_000_000, "reach", "pre-model anchor", "India/global", "workbook", "internal evidence", "source anchors", "low-medium", "inference", "addressable cap", "eligible growth", "identity and consent haircut", 800_000_000, "reach is weakest evidence for individual eligibility"),
        ("A008", "OTP verification rate", float(params.loc[params['parameter_name'].str.contains('claim|verification', case=False, na=False), 'base_value'].head(1).fillna(0.116).iloc[0]) if not params.empty else 0.116, "rate", "calibration", "India/global", "workbook and CSV", "calibrated assumption", "parameter registry", "medium", "derived", "verification", "claim_rate", "fit to scale-base trajectory", float(launch["verified_users"] / launch["eligible_identity_count"]), "needs observed pilot conversion"),
        ("A009", "historical campaign participation", float(base["campaign_participants"].sum()), "participants", "simulated period", "India/global", "simulation database", "simulated", "BASE_CASE_PERIOD_DATA", "model", "simulated", "campaign system", "campaign_participants", "monthly simulation", float(base["campaign_participants"].sum()), "not observed campaign result"),
        ("A010", "QR / WhatsApp / OBD campaign uplift", float(cohorts["claim_propensity_multiplier"].max()), "multiplier", "cohort assumption", "India", "workbook", "assumption", "Cohort_Inputs", "medium-low", "assumed", "campaign conversion", "claim_propensity_multiplier", "cohort multiplier", float(cohorts["claim_propensity_multiplier"].max()), "must be measured in pilot"),
        ("A011", "available Zee financial data", float(launch["annualized_network_revenue_usd"]), "USD annualized", "TGE", "global", "simulation database", "simulated/calibrated", "BASE_CASE_PERIOD_DATA", "model", "simulated", "treasury", "annualized_network_revenue_usd", "scale-base model", float(launch["annualized_network_revenue_usd"]), "not audited company forecast"),
        ("A012", "crypto comparable deflation", 0.20, "launch price USD", "TGE", "market", "token launch workbook", "management scenario", "Token_Launch", "low-medium", "assumed", "valuation", "launch_price", "drawdown and execution haircut", 0.20, "not a market forecast"),
    ]
    anchors = pd.DataFrame(anchor_rows, columns=[
        "anchor_id", "metric", "value", "unit", "period", "geography", "source", "source_type", "page_or_section", "confidence", "direct_observation_or_inference", "model_component_affected", "parameter_affected", "transformation_or_haircut", "final_calibrated_value", "limitation",
    ])

    data_dictionary = pd.DataFrame([{
        "field": c,
        "unit": infer_unit(c),
        "instrument": infer_instrument(c),
        "classification": infer_classification(c),
        "description": c.replace("_", " "),
        "source_table": "BASE/DOWNSIDE/UPSIDE_CASE_PERIOD_DATA.csv",
        "report_usage": "period analysis, charts and validation",
    } for c in base.columns])

    database_tables = pd.DataFrame([
        {"table": name, "file": f"{name}.csv", "primary_key": "period + scenario" if "PERIOD_DATA" in name else "row order / natural key", "time_field": "period where present", "scenario_field": "scenario where present", "cohort_field": "cohort where present", "instrument_fields": "acr_*, z1u_*, z1_token_* where present", "run_identifier": "RUN_MANIFEST working_tree_identifier", "source_identifier": "DATA_SOURCE_REGISTER source_id"}
        for name in [
            "BASE_CASE_PERIOD_DATA", "DOWNSIDE_CASE_PERIOD_DATA", "UPSIDE_CASE_PERIOD_DATA", "PARAMETER_REGISTRY",
            "COHORT_TRANSITION_MATRIX", "MONTE_CARLO_SUMMARY", "TOKEN_SUPPLY_AND_UNLOCK_SCHEDULE", "TOKEN_LAUNCH_GATES",
            "TRAIN_FIT_RESULTS", "HOLDOUT_RESULTS", "RESIDUAL_DIAGNOSTICS",
        ]
    ])

    risk = pd.DataFrame(build_risks())
    recommendations = pd.DataFrame(build_recommendations())
    insights = build_insights(base, scenario_comparison)

    observed_matrix = ctx["observed"].copy()
    observed_matrix["report_classification"] = observed_matrix.get("observed_inferred_assumed", "classified")

    parameter_register = params.copy()
    for col, default in {
        "parameter_id": [f"P{i+1:03d}" for i in range(len(parameter_register))],
        "lifecycle_stage": "cross-system",
        "scenario": "downside/base/upside",
        "implemented_value": parameter_register.get("base_value", pd.Series([""] * len(parameter_register))),
        "temporal_behavior": "monthly calibrated trajectory or fixed scenario value",
        "cohort_behavior": "cohort multipliers where available",
        "elasticity": "see SENSITIVITY_RESULTS.csv",
        "identifiability": "see IDENTIFIABILITY_MATRIX.csv",
        "implementation_file": "projects/z1/empirical_calibrated_simulation/model.py",
        "database_field": parameter_register.get("parameter_name", pd.Series([""] * len(parameter_register))),
        "report_usage": "calibration, scenario interpretation and risk review",
        "recommendation": "retain for pilot, recalibrate with observed production data",
    }.items():
        if col not in parameter_register.columns:
            parameter_register[col] = default

    mechanism_parameter_guide = build_mechanism_parameter_guide(base, launch, final)

    return {
        "data_dictionary": data_dictionary,
        "database_tables": database_tables,
        "anchors": anchors,
        "observed_matrix": observed_matrix,
        "parameter_register": parameter_register,
        "mechanisms": mechanisms,
        "mechanism_parameter_guide": mechanism_parameter_guide,
        "transitions": transitions,
        "cohorts": cohorts,
        "funnel": funnel,
        "acr": acr,
        "z1u": z1u,
        "settlement": settlement,
        "campaign": campaign,
        "treasury": treasury,
        "allocation": allocation,
        "token_supply": token_supply,
        "token_launch": token_launch,
        "valuation": valuation,
        "gates": gates,
        "scenario_comparison": scenario_comparison,
        "stress": stress,
        "mc": mc,
        "sensitivity": sensitivity,
        "identifiability": identifiability,
        "risk": risk,
        "recommendations": recommendations,
        "insights": insights,
    }


def infer_unit(col: str) -> str:
    if col.endswith("_usd") or "market_cap" in col or "fdv" in col or "gmv" in col or "revenue" in col or "cash" in col:
        return "USD"
    if col.endswith("_days"):
        return "days"
    if "rate" in col or "share" in col or "utilization" in col:
        return "ratio"
    if "z1u" in col:
        return "Z1U"
    if "acr" in col:
        return "ACR"
    if "supply" in col or "unlock" in col:
        return "Z1 tokens"
    if "users" in col or "identity" in col or "audience" in col or "participants" in col:
        return "people/accounts"
    return "model unit"


def infer_instrument(col: str) -> str:
    if col.startswith("acr_") or col in {"pending_acr_end", "held_acr_balance_end"}:
        return "ACR"
    if "z1u" in col or "utility_" in col or "provider_payout_z1u" in col:
        return "Z1U"
    if col.startswith("z1_token") or col.startswith("z1_"):
        return "Z1 token"
    if "cash" in col or "treasury" in col or "reserve" in col:
        return "treasury"
    return "operational"


def infer_classification(col: str) -> str:
    if col in {"period", "scenario", "model_split", "launch_phase"}:
        return "database key"
    if "shock" in col or "multiplier" in col or "price" in col:
        return "assumed/scenario"
    if "cumulative" in col or "ratio" in col or "share" in col:
        return "derived"
    return "simulated"


def build_risks() -> list[dict[str, Any]]:
    risks = [
        ("audience overcounting", "medium", "high", "pre-launch", "eligibility", "eligible/verified gap", "modeled as convergence", "dedupe not proven", "identity resolution and consent audit", "data/product", "conditional"),
        ("duplicate identities", "medium", "high", "pilot", "verification", "duplicate profile rate", "not explicitly modeled", "needs production dedupe", "device/phone/account graph controls", "data", "conditional"),
        ("consent and eligibility", "medium", "high", "pre-launch", "audience eligibility", "consent opt-in rate", "not a stock-flow constraint", "legal eligibility missing", "jurisdictional consent framework", "legal", "blocker"),
        ("fraud", "medium", "medium", "pilot", "claims and settlement", "failed verification, anomalies", "hold/void rates", "empirical rates missing", "fraud rules and manual review queue", "risk", "conditional"),
        ("verification bottlenecks", "medium", "high", "TGE", "verified users", "claim conversion", "launch gate", "operational throughput missing", "capacity plan and SLA", "product/ops", "conditional"),
        ("weak activity retention", "medium", "high", "post-launch", "active users", "churn rate", "monthly churn modeled", "cohort retention not observed", "retention pilots", "product", "conditional"),
        ("campaign dependency", "medium", "medium", "pilot", "campaign system", "campaign-funded share", "campaign data modeled", "historical transfer risk", "separate organic and paid activity", "commercial", "watch"),
        ("subsidy dependency", "medium", "high", "post-launch", "utility", "user-funded share", "funding mix table", "true willingness-to-pay missing", "require paid utility KPIs", "finance", "conditional"),
        ("settlement backlog", "low-medium", "high", "TGE", "queue", "avg/p95 queue age", "queue modeled", "capacity SLA missing", "capacity reserve and throttles", "ops/treasury", "conditional"),
        ("treasury liquidity", "medium", "high", "TGE", "treasury", "minimum cash", "cash modeled", "token sale reliance policy unclear", "reserve policy", "finance", "conditional"),
        ("provider concentration", "medium", "medium", "post-launch", "utility supply", "top provider share", "not modeled", "provider data missing", "provider diversification", "partnerships", "watch"),
        ("brand revenue shortfall", "medium", "high", "pre-TGE", "revenue", "signed commitments", "stress tested", "pipeline evidence missing", "signed LOIs/contracts", "commercial", "conditional"),
        ("utility circularity", "medium", "high", "post-launch", "Z1U", "brand/campaign funded share", "flow table", "organic demand unproven", "user-paid utility thresholds", "product/finance", "conditional"),
        ("excessive ACR obligations", "medium", "high", "post-launch", "ACR", "pending ACR and request rate", "stock-flow modeled", "legal/liability treatment uncertain", "caps and vesting controls", "legal/finance", "conditional"),
        ("unlock pressure", "high", "high", "post-TGE", "Z1 token", "monthly unlock/float", "unlock schedule modeled", "sell behavior assumed", "longer vesting and utility gating", "treasury", "conditional"),
        ("low-float mechanics", "medium", "medium", "TGE", "market", "float and liquidity depth", "initial float modeled", "market microstructure missing", "liquidity commitments", "treasury", "conditional"),
        ("legal classification", "medium", "critical", "pre-TGE", "token", "legal memo status", "not modeled", "external counsel required", "terms, disclosures, geofencing", "legal", "blocker"),
        ("privacy", "medium", "critical", "pre-launch", "identity", "DPIA completion", "not modeled", "privacy review missing", "data minimization and consent", "legal/data", "blocker"),
        ("smart-contract risk", "medium", "high", "pre-TGE", "vesting/contracts", "audit findings", "not modeled", "contract audit missing", "security audit", "engineering", "blocker"),
        ("model risk", "medium", "high", "ongoing", "all", "holdout WAPE and drift", "fit diagnostics", "live calibration missing", "model governance and validation", "quant/data", "conditional"),
    ]
    return [{"risk": r, "probability": p, "severity": s, "time_horizon": h, "affected_mechanism": m, "early_warning_indicator": e, "current_model_treatment": t, "gap": g, "mitigation": mit, "owner": o, "launch_blocker_status": b} for r, p, s, h, m, e, t, g, mit, o, b in risks]


def build_mechanism_parameter_guide(base: pd.DataFrame, launch: pd.Series, final: pd.Series) -> pd.DataFrame:
    rows = [
        ("Audience eligibility", "maximum_addressable_audience", "Upper bound of reachable Zee-linked audience used by the model.", "people/accounts", "anchor/scenario cap", "maximum_addressable_audience", launch["maximum_addressable_audience"], final["maximum_addressable_audience"], "This is a ceiling, not a forecast of claimants.", "Overstating it makes every downstream conversion look stronger than it is.", "Keep in model, but disclose as a reach-derived cap and require dedupe/consent evidence before public use."),
        ("Audience eligibility", "starting_eligible_identities", "Initial pool treated as eligible at simulation start.", "people/accounts", "derived/internal anchor", "eligible_identity_count", base.iloc[0]["eligible_identity_count"], launch["eligible_identity_count"], "Drives the early ramp into verification.", "Profile quality and consent may be weaker than assumed.", "Validate with a cohort-level identity audit before large-scale Air-Claim."),
        ("Audience eligibility", "eligible_convergence_rate", "Monthly speed at which addressable audience becomes eligible.", "monthly rate", "calibrated assumption", "eligible_identity_count", base["eligible_identity_count"].pct_change().median(), final["eligible_identity_count"], "Controls how fast reach turns into actionable eligibility.", "Can hide operational onboarding constraints.", "Estimate from pilot opt-in waves instead of fitting only to scale-base trajectory."),
        ("Verification", "claim_rate", "Share of unverified eligible identities that claim or verify each month.", "monthly rate", "calibrated behavioral assumption", "claim_rate", launch["claim_rate"], final["claim_rate"], "Main driver of TGE readiness.", "Weakly supported until observed claim campaigns run.", "Make this the primary pilot KPI; report by acquisition channel and geography."),
        ("Verification", "OTP / identity success", "Implied ability to turn a claim into a verified identity.", "rate", "anchor plus assumption", "verified_users", launch["verified_users"] / launch["eligible_identity_count"], final["verified_users"] / final["eligible_identity_count"], "Determines whether distribution reach becomes usable participants.", "Duplicates and failed KYC/OTP can break the funnel.", "Instrument reason codes for failed verification and feed them into calibration."),
        ("Activation and retention", "activation probability", "Share of verified users who become active.", "rate", "calibrated behavioral assumption", "active_users", launch["active_users"] / launch["verified_users"], final["active_users"] / final["verified_users"], "Converts verified identity into product activity.", "Can be inflated by short-term campaign activity.", "Separate organic active users from campaign-attributed active users in dashboards."),
        ("Activation and retention", "monthly_churn_rate", "Rate at which active users leave active state.", "monthly rate", "calibrated behavioral assumption", "monthly_churn_rate", launch["monthly_churn_rate"], final["monthly_churn_rate"], "Determines durability of the user base.", "Aggregated churn can mask weak cohorts.", "Require cohort-retention curves before using year-5 active users externally."),
        ("Activation and retention", "monthly_reactivation_rate", "Rate at which dormant users return to active state.", "monthly rate", "calibrated behavioral assumption", "monthly_reactivation_rate", launch["monthly_reactivation_rate"], final["monthly_reactivation_rate"], "Controls recovery after dormancy and campaign lifts.", "May double-count paid campaign effects.", "Tag reactivation by trigger: organic, campaign, content, referral, support."),
        ("ACR issuance", "average_acr", "Average recognition credit issued per new verified user.", "ACR/user", "calibrated/structural assumption", "acr_issued", launch["acr_issued"] / max(launch["new_verified_users"], 1), final["acr_issued"] / max(final["new_verified_users"], 1), "Links historical contribution to non-transferable recognition.", "Large values can create latent settlement expectations.", "Publish clear ACR terms: personal, non-transferable, reviewable, capped by release policy."),
        ("ACR vesting", "vesting lag", "Delay before issued ACR becomes available.", "months", "structural assumption", "acr_vested", 12, 12, "Smooths settlement pressure.", "Too short a lag can create queue spikes.", "Retain or lengthen vesting until observed request behavior is stable."),
        ("ACR review", "hold rate", "Share of requested ACR placed in hold/review.", "rate", "structural assumption", "acr_held", launch["acr_held"] / max(launch["acr_requested"], 1), final["acr_held"] / max(final["acr_requested"], 1), "Fraud and evidence-control mechanism.", "If too low, bad claims settle; if too high, user trust suffers.", "Calibrate to observed fraud and dispute rates; publish SLA for held claims."),
        ("ACR review", "void rate", "Share of requested ACR voided after review.", "rate", "structural assumption", "acr_voided", launch["acr_voided"] / max(launch["acr_requested"], 1), final["acr_voided"] / max(final["acr_requested"], 1), "Controls invalid obligations.", "Legal and reputational risk if users see voiding as arbitrary.", "Define evidence rules and appeal process before opening mass claims."),
        ("ACR to Z1U settlement", "z1u_per_released_acr", "Internal accounting reference applied to released ACR.", "Z1U/ACR", "structural assumption", "z1u_demand", launch["z1u_demand"] / max(launch["acr_settled_released"], 1), final["z1u_demand"] / max(final["acr_settled_released"], 1), "Connects recognition to utility accounting without creating a traded claim.", "Can be misread as redemption value.", "Keep language explicit: this is governed utility release, not a guaranteed cash/token redemption."),
        ("Settlement capacity", "z1u_capacity", "Monthly capacity to fill settlement demand.", "Z1U/month", "calibrated operating assumption", "z1u_capacity", launch["z1u_capacity"], final["z1u_capacity"], "Primary control on queue stability.", "Over-optimistic capacity can hide launch risk.", "Pre-provision capacity and monitor p95 queue age, failed requests, and backlog clearance time."),
        ("Settlement queue", "queue age thresholds", "Average and p95 wait time for settlement queue.", "days", "simulated operating metric", "queue_age_avg_days / queue_age_p95_days", launch["queue_age_avg_days"], base["queue_age_p95_days"].max(), "Operational trust indicator.", "Delays can trigger churn and negative token sentiment.", "Make p95 queue age a formal launch gate, not only average age."),
        ("Z1U utility", "utility adoption rate", "Share of active users who use Z1U utility.", "rate", "calibrated behavioral assumption", "utility_users", launch["utility_users"] / launch["active_users"], final["utility_users"] / final["active_users"], "Core proof of actual service demand.", "Can be inflated by subsidies or brand funding.", "Report user-funded utility separately and set minimum organic-utility thresholds."),
        ("Z1U utility", "spend per utility user", "Z1U spent per utility user per period.", "Z1U/user/month", "calibrated behavioral assumption", "utility_spend_z1u", launch["utility_spend_z1u"] / launch["utility_users"], final["utility_spend_z1u"] / final["utility_users"], "Determines GMV, fees and provider payouts.", "Spend quality matters more than raw spend volume.", "Segment spend by category and funding source before describing demand as organic."),
        ("Z1U utility", "utility fee rate", "Fee retained from utility spend.", "rate", "structural assumption", "fee_amount_z1u", launch["fee_amount_z1u"] / launch["utility_spend_z1u"], final["fee_amount_z1u"] / final["utility_spend_z1u"], "Revenue extraction from utility economy.", "Too high a fee can suppress provider participation.", "Keep fee modest during pilot and optimize after measuring provider elasticity."),
        ("Z1U utility", "burn rate", "Share of fees removed/burned.", "rate", "structural tokenomics assumption", "burn_amount_z1u", launch["burn_amount_z1u"] / launch["fee_amount_z1u"], final["burn_amount_z1u"] / final["fee_amount_z1u"], "Narrative and supply-sink mechanism.", "Burn is secondary if utility demand is weak.", "Do not market burn as the main value driver; prioritize paid utility and retention."),
        ("Campaign system", "campaign success rate", "Modeled success ratio for campaign participation and attribution.", "rate", "calibrated/assumed", "campaign_success_rate", launch["campaign_success_rate"], final["campaign_success_rate"], "Drives attributed activation and transactions.", "Historical campaign response may not transfer to token participation.", "Apply conversion haircuts and measure channel-by-channel response in pilot."),
        ("Campaign system", "campaign budget", "Monthly campaign spend used for acquisition/reactivation.", "USD/month", "scenario assumption", "campaign_budget_usd", launch["campaign_budget_usd"], final["campaign_budget_usd"], "Subsidy/acquisition lever.", "Can mask weak organic retention.", "Cap spend by payback period and separate paid from organic cohorts."),
        ("Treasury", "brand revenue", "Monthly brand/commercial revenue feeding treasury.", "USD/month", "simulated/calibrated", "brand_revenue_usd", launch["brand_revenue_usd"], final["brand_revenue_usd"], "Primary non-token cash inflow.", "Unsigned pipeline would make solvency look stronger than reality.", "Require signed commitments and scenario haircut before TGE disclosure."),
        ("Treasury", "operating expense", "Monthly operating cost base.", "USD/month", "scenario assumption", "op_ex_usd", launch["op_ex_usd"], final["op_ex_usd"], "Determines cash runway.", "Compliance/support/security costs may be understated.", "Add production cost reserves and run +30% OpEx stress continuously."),
        ("Treasury", "settlement reserve", "Cash or reserve buffer for settlement operations.", "USD", "simulated treasury stock", "settlement_reserve_usd", launch["settlement_reserve_usd"], final["settlement_reserve_usd"], "Protects settlement reliability.", "Reserve policy is not the same as legal liability treatment.", "Adopt board-approved reserve coverage ratios before settlement launch."),
        ("Z1 token launch", "launch price", "Management scenario price at token launch.", "USD/Z1", "management scenario", "z1_token_launch_price_usd", launch["z1_token_launch_price_usd"], final["z1_token_launch_price_usd"], "Determines FDV and circulating market cap.", "Can be mistaken for forecast or guarantee.", "Retain $0.20 only conditionally; reduce or delay if revenue, legal, utility or liquidity gates miss."),
        ("Z1 token launch", "initial circulation", "Initial circulating Z1 supply at TGE.", "Z1 tokens", "token schedule", "z1_token_circulating_supply", launch["z1_token_circulating_supply"], final["z1_token_circulating_supply"], "Affects market discovery and sell pressure.", "Too low risks manipulation; too high risks overhang.", "Keep 15% only with committed liquidity, market-maker controls and unlock transparency."),
        ("Z1 token launch", "FDV", "Launch price multiplied by maximum token supply.", "USD", "valuation reference", "z1_token_fdv_usd", launch["z1_token_fdv_usd"], final["z1_token_fdv_usd"], "Headline valuation reference.", "Weak if not supported by verified utility and revenue.", "Use multiple lenses; do not defend FDV with audience size alone."),
        ("Z1 token launch", "monthly unlocks", "Additional Z1 entering circulation after TGE.", "Z1 tokens/month", "token schedule", "z1_monthly_unlocks", launch["z1_monthly_unlocks"], final["z1_monthly_unlocks"], "Creates sell-pressure risk.", "Recipient behavior is not empirically calibrated.", "Tie discretionary unlocks to utility, liquidity depth, legal clearance and market stability."),
        ("Fundamental reference", "verified-user weight", "Weight of verified-user scale in internal reference value.", "weight", "internal formula assumption", "z1_fundamental_reference_price_usd", 0.45, 0.45, "Rewards verified scale in internal reference.", "Formula expansion can look like price appreciation.", "Show contribution bridge and label as internal reference only."),
        ("Fundamental reference", "utility-user weight", "Weight of utility adoption in internal reference value.", "weight", "internal formula assumption", "z1_fundamental_reference_price_usd", 0.20, 0.20, "Links value reference to utility depth.", "Utility quality matters more than count.", "Use paid utility and repeat transactions as stronger future inputs."),
        ("Fundamental reference", "revenue weight", "Weight of revenue in internal reference value.", "weight", "internal formula assumption", "z1_fundamental_reference_price_usd", 0.35, 0.35, "Links reference value to monetization.", "Revenue mix can hide subsidy/campaign circularity.", "Separate brand, user-funded, campaign and fee revenue in every investor output."),
    ]
    return pd.DataFrame(rows, columns=[
        "mechanism", "parameter", "plain_english_definition", "unit", "evidence_status", "database_field",
        "tge_value_or_proxy", "year5_value_or_proxy", "how_it_changes_results", "main_risk", "recommendation",
    ])


def build_recommendations() -> list[dict[str, Any]]:
    recs = [
        ("before pilot", "Audience claims exceed proof quality", "1.45B reach is modeled as eligibility over time, not immediate users", "run identity dedupe, consent and cohort sampling pilot", "maximum_addressable_audience", "higher confidence eligibility", "medium", "data/product", "critical", "dedupe rate and opt-in rate"),
        ("before large-scale Air-Claim", "ACR release can become latent obligation", "ACR issued and pending balances are large relative to settlement capacity", "cap monthly ACR release and publish hold/void policy", "acr_requested, z1u_filled", "lower queue risk", "medium", "treasury/legal", "critical", "p95 queue age < 7 days"),
        ("before utility launch", "Utility may be subsidy-driven", "Z1U flow table separates user, brand and campaign funding", "require user-funded utility KPIs by cohort", "z1u_purchased_by_users", "less circular demand", "medium", "product/finance", "high", "user-funded share > 50%"),
        ("before settlement launch", "Capacity is a launch constraint", "stress cases show queue sensitivity", "pre-provision capacity and outage runbooks", "z1u_capacity", "lower backlog risk", "medium", "operations", "high", "max p95 queue age threshold"),
        ("before token generation event", "$0.20 and $2B FDV need operating proof", "TGE passes base gates but legal/liquidity gates remain outside model", "retain $0.20 only conditionally; reduce or delay if revenue or legal gates fail", "z1_token_launch_price_usd", "valuation discipline", "medium", "treasury/executive", "critical", "all launch gates pass"),
        ("before token generation event", "15% initial circulation may be thin for honest price discovery", "initial float is 1.5B tokens / $300M market cap", "require $30M-$45M committed liquidity and transparent market operations", "z1_token_circulating_supply", "lower manipulation risk", "high", "treasury", "critical", "liquidity coverage ratio"),
        ("before token generation event", "45% community allocation creates overhang", "allocation is credible only with vesting and contribution evidence", "retain 45% only with claim gating, vesting, and utility participation requirements", "community_and_audience", "better alignment", "medium", "governance/legal", "high", "claim-to-utility conversion"),
        ("first 30 days after TGE", "Unlock pressure can dominate narrative", "unlock share chart highlights early float sensitivity", "freeze discretionary unlocks if liquidity or utility gates miss", "z1_unlock_share_of_circulating", "lower sell pressure", "low", "treasury", "high", "unlock/liquidity ratio"),
        ("first year after TGE", "Burn is economically small versus GMV", "burn is fee-rate derived, not primary demand", "do not market burn as core value driver; tune only after utility data", "burn_amount_z1u", "cleaner communications", "low", "commercial/legal", "medium", "burn/revenue share"),
        ("long-term token policy", "Market price module is not defensible as forecast", "current model includes fundamental reference and stress ranges, not full market microstructure", "keep Z1U non-transferable and separate market disclosure from internal reference value", "z1_market_price_scenario_usd", "reduced legal and model risk", "medium", "legal/treasury", "critical", "disclosure review completion"),
    ]
    return [{"stage": a, "issue": b, "evidence": c, "proposed_action": d, "parameter_or_mechanism_affected": e, "expected_impact": f, "implementation_complexity": g, "owner": h, "urgency": i, "success_metric": j} for a, b, c, d, e, f, g, h, i, j in recs]


def build_insights(base: pd.DataFrame, scenarios: pd.DataFrame) -> list[dict[str, Any]]:
    launch = base.iloc[11]
    final = base.iloc[-1]
    return [
        {"rank": 1, "insight": "The real bottleneck is verified and active conversion, not raw audience scale.", "evidence": f"At TGE {compact(launch['eligible_identity_count'])} eligible identities become {compact(launch['verified_users'])} verified and {compact(launch['active_users'])} active.", "strategic_importance": "critical", "confidence": "high", "urgency": "pre-launch", "affected_stakeholder": "executives/product/quant"},
        {"rank": 2, "insight": "The base launch is operationally ready by model gates, but only because settlement queues remain controlled.", "evidence": f"Launch gate status is LAUNCH READY and max average queue age is {base['queue_age_avg_days'].max():.2f} days.", "strategic_importance": "critical", "confidence": "high", "urgency": "TGE", "affected_stakeholder": "ops/treasury"},
        {"rank": 3, "insight": "The $0.20 price is defensible only as a conditional management case, not as a forecast.", "evidence": f"TGE FDV/revenue multiple is {launch['z1_token_fdv_usd']/launch['annualized_network_revenue_usd']:.1f}x and legal/liquidity gates are outside the current model.", "strategic_importance": "critical", "confidence": "medium", "urgency": "pre-TGE", "affected_stakeholder": "treasury/legal"},
        {"rank": 4, "insight": "User-funded utility is more important than burn mechanics.", "evidence": "Burn is a derivative of utility fees; it cannot compensate for weak paid utility adoption.", "strategic_importance": "high", "confidence": "high", "urgency": "utility launch", "affected_stakeholder": "product/finance"},
        {"rank": 5, "insight": "ACR is manageable only if it stays personal, non-transferable and release-capped.", "evidence": f"Cumulative ACR issuance is {compact(base['acr_issued'].sum())}; settlement pressure depends on request and release rates.", "strategic_importance": "high", "confidence": "medium", "urgency": "before settlement", "affected_stakeholder": "legal/treasury"},
        {"rank": 6, "insight": "Year-5 $0.70 reference is formula-driven by users and revenue, not a market-price forecast.", "evidence": f"Year-5 reference price is {money(final['z1_fundamental_reference_price_usd'])} while market price simulation is explicitly not implemented as a forecast.", "strategic_importance": "high", "confidence": "high", "urgency": "disclosure", "affected_stakeholder": "legal/executives"},
        {"rank": 7, "insight": "Initial circulation is large enough to avoid extreme low-float optics but still creates overhang questions.", "evidence": "Base launch uses 15% initial circulation and a 45% community/audience allocation.", "strategic_importance": "high", "confidence": "medium", "urgency": "pre-TGE", "affected_stakeholder": "treasury/tokenomics"},
        {"rank": 8, "insight": "Zee distribution is a genuine advantage only if identity quality and opt-in conversion are measured.", "evidence": "The model converts massive reach through explicit eligibility, verification and activation gates rather than assuming immediate token users.", "strategic_importance": "high", "confidence": "medium", "urgency": "pilot", "affected_stakeholder": "commercial/data"},
    ]


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
    ctx = build_data()
    tables = make_tables(ctx)
    write_all(ctx, tables)
    make_figures(ctx, tables)
    write_reports(ctx, tables)
    finalize(ctx)


if __name__ == "__main__":
    main()
