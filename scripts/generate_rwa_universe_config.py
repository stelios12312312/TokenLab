"""Generate src/TokenLab/agentic/data/rwa_universe_case_study.yaml from the verified 3-fund config plus compact specs."""
import copy
from pathlib import Path
import yaml

REPO = str(Path(__file__).resolve().parents[1])
base = yaml.safe_load(open(f"{REPO}/src/TokenLab/agentic/data/real_rwa_funds_case_study.yaml", encoding="utf-8"))
AS_OF = "2026-10-28"
ONCHAIN = "Kamino Lend reserves read on-chain (Solana mainnet RPC): collateral deposited / total AUM"


def rwa(t):
    return f"https://app.rwa.xyz/assets/{t}"


def doc(src, url, conf="medium", note=None, sweep=None, as_of=AS_OF):
    e = {"source": src, "url": url, "as_of": as_of, "confidence": conf}
    if note:
        e["note"] = note
    if sweep:
        e["sweep"] = sweep
    return e


def assume(note, sweep):
    return {"assumption": True, "note": note, "sweep": sweep}


NA = lambda note: {"applicable": False, "note": note}

# Shared assumption templates (values, sweeps)
COMMON_ASSUMPTIONS = {
    "portfolio_expense_annual": (0.0, assume("fund expenses beyond fees not disclosed", [0.0, 0.001, 0.0025])),
    "fixed_operating_cost_annual": (210000.0, assume("illustrative standalone tokenised-fund cost base", [100000.0, 210000.0, 500000.0])),
    "variable_operating_cost_bps": (12.0, assume("illustrative", [5.0, 12.0, 25.0])),
    "secondary_required_return_annual": (0.12, assume("required return of a secondary buyer", [0.08, 0.12, 0.20])),
    "secondary_illiquidity_premium": (0.01, assume("allowance for mark uncertainty and thin DEX depth", [0.0, 0.01, 0.03])),
    "platform_admin_fee_annual": (0.0, assume("platform / administration fees not separately disclosed", [0.0, 0.001])),
}

# Compact specs. y = net 30-day yield (rwa.xyz NAV accrual unless noted); fees from sources where given.
SPECS = [
    dict(id="ustb", ticker="USTB", name="Superstate USTB (short-duration US Treasuries, managed by Invesco)", short="USTB (T-bills)",
         issuer="Superstate / Invesco", asset="US Treasury bills", rail="Ethereum, Solana", tbill=True,
         net=0.0373, mgmt=0.0015, mgmt_src="rwa.xyz USTB: 0.15% management fee", policy="accumulating",
         lag=0, lag_doc="Daily redemption at 9am ET", gate=None, gate_doc="Daily redemptions, no gate published",
         buffer=0.0, haircut=3.0, aum=504e6, holders=96, looped=0.0, credit_beta=0.0,
         notes="US accredited investors only; $100k minimum"),
    dict(id="usdy", ticker="USDY", name="Ondo USDY (tokenised note backed by T-bills and bank deposits)", short="USDY (T-bills)",
         issuer="Ondo Finance", asset="US Treasury bills and bank deposits", rail="Ethereum, Solana and others", tbill=True,
         net=0.0368, mgmt=None, policy="accumulating",
         lag=0, lag_doc="Daily redemption, $100k minimum, non-US investors, 40-day transfer lock after minting", gate=None,
         gate_doc="Daily redemptions, no gate published", buffer=0.0, haircut=3.0, aum=2.38e9, holders=17928, looped=0.0, credit_beta=0.0,
         notes="Ondo's fee is taken as a spread and not published as a rate"),
    dict(id="wylds", ticker="YLDS", name="Figure YLDS / wYLDS (SEC-registered $1 note backed by T-bills and repo)", short="wYLDS (T-bill note)",
         issuer="Figure Certificate Company", asset="US Treasury bills and repo (SEC-registered face-amount certificate)", rail="Provenance, Solana (wYLDS)",
         tbill=True, net=None, net_assumed=0.0346, net_note="about SOFR minus 50 bp (weak source); assumed 3.46%", mgmt=None, policy="full_net_income",
         lag=0, lag_doc="Instant redemption at $1", gate=None, gate_doc="Instant redemption, no gate published",
         buffer=0.0, haircut=3.0, aum=485e6, holders=4029, looped=0.0, credit_beta=0.0,
         notes="Kamino lists wYLDS as a borrowable asset ($63M supplied), not as collateral"),
    dict(id="cetes", ticker="CETES", name="Etherfuse CETES (tokenised Mexican federal T-bills)", short="CETES (MXN T-bills)",
         issuer="Etherfuse", asset="Mexican government T-bills (peso; USD value carries FX risk)", rail="Solana",
         tbill=False, net=0.056, net_note="5.6% in peso terms; USD returns move with MXN/USD", mgmt=None, policy="accumulating",
         lag=0, lag_doc="Instant redemption at NAV", gate=None, gate_doc="Instant redemption, no gate published",
         buffer=0.0, haircut=50.0, aum=4.3e6, holders=5026, looped=0.0, credit_beta=0.0, fx=True,
         notes="NAV in USD fell 4.6% over 30 days with the peso"),
    dict(id="acred", ticker="ACRED", name="Apollo Diversified Credit (ACRED, tokenised by Securitize)", short="ACRED (private credit)",
         issuer="Apollo / Securitize", asset="Diversified private credit", rail="Ethereum, Solana and others",
         tbill=False, net=None, net_assumed=0.08, net_note="30-day return -4.4% (unexplained mark or distribution); 8% net assumed", mgmt=0.005,
         mgmt_src="rwa.xyz ACRED: 0.50% management fee", policy="accumulating",
         lag=3, gate=0.0167, gate_doc="Quarterly redemptions with a 5% gate (secondary sources); modelled as 1.67% per month",
         gate_assumed=True, buffer=0.05, haircut=100.0, aum=95e6, holders=53, looped=0.0, credit_beta=0.8,
         notes="$50k minimum; gate and notice from secondary sources"),
    dict(id="prime", ticker="PRIME", name="Hastra PRIME (Figure home-equity lines of credit)", short="PRIME (HELOCs)",
         issuer="Hastra / Figure", asset="Home-equity lines of credit (HELOCs)", rail="Solana",
         tbill=False, net=0.060, mgmt=0.005, mgmt_src="rwa.xyz PRIME: 0.50% management fee", policy="accumulating",
         lag=1, gate=None, gate_doc="Listed as instant; the final step to USD runs through an operator in banking hours",
         buffer=0.05, haircut=75.0, aum=579e6, holders=1979, looped=87 / 579, credit_beta=1.0,
         notes="instant in name; operator-run final redemption step"),
    dict(id="auto", ticker="AUTO", name="Hastra AUTO (Figure near-prime auto loans)", short="AUTO (auto loans)",
         issuer="Hastra / Figure", asset="Near-prime auto loans", rail="Solana",
         tbill=False, net=0.097, mgmt=None, policy="accumulating",
         lag=1, gate=None, gate_doc="Instant or next business day; operator-run final step",
         buffer=0.05, haircut=100.0, aum=103e6, holders=691, looped=min(0.95, 99 / 103), credit_beta=1.4,
         notes="three months old; most supply is Kamino collateral"),
    dict(id="onyc", ticker="ONyc", name="OnRe ONyc (tokenised reinsurance)", short="ONyc (reinsurance)",
         issuer="OnRe (Bermuda)", asset="Property and casualty reinsurance", rail="Solana",
         tbill=False, net=0.105, mgmt=None, perf=0.20, perf_src="20% performance fee (rwa.xyz / issuer materials)", policy="accumulating",
         exit_fee=0.003, exit_src="0.30% redemption fee (rwa.xyz)", lag=3, gate=None,
         gate_doc="Listed as instant with a 0.30% fee; older docs described quarterly redemption with 30-day notice",
         buffer=0.10, haircut=150.0, aum=301e6, holders=9318, looped=168 / 301, credit_beta=1.6,
         notes="redemption terms changed over time; management fee given as 0% or 0.75% by different sources"),
    dict(id="reusd", ticker="reUSD", name="Re reUSD (senior tranche of a reinsurance pool)", short="reUSD (reinsurance senior)",
         issuer="Re (Resilience, BVI)", asset="Reinsurance, senior tranche (about $77M first-loss equity below)", rail="Ethereum, Solana",
         tbill=False, net=0.0646, net_note="SOFR + 250 bp per issuer (SOFR proxied by the risk-free rate)", mgmt=None, policy="accumulating",
         exit_fee=0.0018, exit_src="0.18% redemption fee (rwa.xyz)", lag=3, gate=None,
         gate_doc="Instant while the liquidity buffer lasts, then quarterly", buffer=0.10, haircut=100.0,
         aum=364e6, holders=2547, looped=10 / 364, credit_beta=0.2, notes="issuer docs contradict on yield formula and redemption"),
    dict(id="pst", ticker="PST", name="Huma PST (payments / PayFi credit)", short="PST (payments credit)",
         issuer="Huma Finance", asset="Short-duration payments receivables", rail="Solana",
         tbill=False, net=0.077, mgmt=None, policy="accumulating",
         lag=1, gate=None, gate_doc="Daily redemption; mechanics not documented further", buffer=0.05, haircut=40.0,
         aum=400e6, holders=3941, looped=29 / 400, credit_beta=0.6, notes="very short-duration receivables"),
    dict(id="otfy", ticker="oTFY", name="Obligate oTFY (trade finance)", short="oTFY (trade finance)",
         issuer="Obligate (Luxembourg vehicle)", asset="Trade finance receivables", rail="Solana",
         tbill=False, net=None, net_assumed=0.09, net_note="yield not shown on public pages; 9% net assumed", mgmt=0.01,
         mgmt_src="rwa.xyz oTFY: 1% management fee", perf=0.10, perf_src="10% performance fee (rwa.xyz)", policy="accumulating",
         lag=1, gate=0.33, gate_doc="Weekly with 7-day notice; at least 1/12 of NAV per week, then pro rata (about 33% per month)",
         buffer=0.05, haircut=100.0, aum=29.7e6, holders=48, looped=7.2 / 29.7, credit_beta=1.2,
         notes="since June 2026; issuer can mint and freeze"),
    dict(id="nopal", ticker="nOPAL", name="Plume Nest nOPAL (Brazilian card receivables)", short="nOPAL (card receivables)",
         issuer="Plume Nest", asset="Brazilian credit-card receivables", rail="Plume, Solana",
         tbill=False, net=0.10, net_note="about 10% (DefiLlama)", mgmt=None, policy="accumulating",
         lag=1, gate=None, gate_doc="Daily redemption with 1-5 day settlement (listed elsewhere as instant)",
         buffer=0.05, haircut=100.0, aum=117e6, holders=4152, looped=9.6 / 117, credit_beta=1.4,
         notes="sources disagree on AUM ($12M to $117M); no attestation disclosed"),
    dict(id="susdai", ticker="sUSDai", name="USD.AI sUSDai (GPU-backed loans)", short="sUSDai (GPU loans)",
         issuer="USD.AI (Permian Labs)", asset="Loans secured by GPUs", rail="Arbitrum, Solana",
         tbill=False, net=None, net_assumed=0.10, net_note="loans priced 7-15% APR; 10% net assumed", mgmt=None, policy="accumulating",
         lag=1, gate=None, gate_doc="30-day epochs, first in first out, can roll over (USD.AI docs)", gate_url="https://docs.usd.ai/depositor/susdai",
         buffer=0.02, haircut=150.0, aum=None, holders=None, looped=0.0, credit_beta=1.6,
         notes="AUM not found; LlamaRisk declined it for Aave on liquidity grounds"),
    dict(id="uscc", ticker="USCC", name="Superstate USCC (crypto basis / carry, managed by Bitwise)", short="USCC (crypto carry)",
         issuer="Superstate / Bitwise", asset="Crypto cash-and-carry (basis) with T-bills", rail="Ethereum, Solana",
         tbill=False, net=0.073, net_note="30-day 7.3%, 7-day 1.7%: highly variable", mgmt=0.0075, mgmt_src="rwa.xyz USCC: 0.75% management fee",
         policy="accumulating", lag=0, gate=None, gate_doc="Daily redemption, T+2 or longer", buffer=0.05, haircut=30.0,
         aum=110e6, holders=59, looped=0.0, credit_beta=0.8, basis=True, notes="US accredited only"),
]


def fund_block(sp):
    rf = base["benchmarks"]["risk_free_rate_annual"]
    url = rwa(sp["ticker"])
    mgmt = sp.get("mgmt")
    mgmt_value = 0.005 if mgmt is None else mgmt  # unpublished fees: flagged 0.50% on top of the net yield
    perf = sp.get("perf", 0.0)
    net = sp["net"] if sp.get("net") is not None else sp["net_assumed"]
    gross = net / (1 - perf) + mgmt_value
    if sp["id"] == "reusd":
        net = rf + 0.025
        gross = net + mgmt_value
    prov = {}
    # Yield
    if sp.get("net") is not None:
        prov["gross_yield_annual"] = doc(
            f"rwa.xyz {sp['ticker']}: net yield {sp['net'] * 100:.2f}% plus fees",
            url, "medium", sp.get("net_note"), sweep=[round(gross - 0.01, 4), round(gross, 4), round(gross + 0.01, 4)])
    else:
        prov["gross_yield_annual"] = assume(sp["net_note"], [round(gross - 0.02, 4), round(gross, 4), round(gross + 0.02, 4)])
    prov["capital_appreciation_annual"] = (
        doc("Stable or accruing NAV backed by T-bills", url, "medium") if sp["tbill"]
        else assume("FX drift of MXN/USD assumed zero" if sp.get("fx") else "return modelled as income; losses enter through stress scenarios", [-0.01, 0.0, 0.005])
    )
    prov["portfolio_expense_annual"] = COMMON_ASSUMPTIONS["portfolio_expense_annual"][1]
    if sp["lag"] == 0 and sp["tbill"]:
        prov["settlement_lag_periods"] = doc(sp["lag_doc"], url, "medium")
    else:
        prov["settlement_lag_periods"] = assume(f"time to sell underlying assets ({sp['asset']})", sorted({max(0, sp['lag'] - 1), sp['lag'], sp['lag'] + 1}))
    prov["liquidation_haircut_bps"] = assume("forced-sale cost", sorted({sp["haircut"] / 2, sp["haircut"], sp["haircut"] * 2}))
    prov["reward_token_annual_budget_fiat"] = doc("No token incentive programme on the fund page", url, "low")
    prov["target_cash_buffer_pct"] = (doc("Fully invested in T-bills; no idle cash modelled", url, "medium") if sp["tbill"] or sp.get("fx")
                                      else assume("liquid sleeve not disclosed", sorted({0.0, sp["buffer"], sp["buffer"] * 2})))
    prov["distribution_policy"] = doc("rwa.xyz payout form", url, "medium")
    prov["distribution_reinvestment_rate"] = NA("accumulating; no payouts") if sp["policy"] == "accumulating" else assume("payout form not specified", [0.0, 1.0])
    prov["looped_share"] = doc(ONCHAIN, "https://app.kamino.finance", "medium",
                               note="share of total AUM, not of Solana supply", sweep=[0.0, round(sp["looped"], 3), min(0.95, round(sp["looped"] * 1.5 + 0.1, 3))]) \
        if sp["looped"] > 0 else doc(ONCHAIN + " (none found)", "https://app.kamino.finance", "medium")
    prov["management_fee_annual"] = (doc(sp["mgmt_src"], url, "medium") if mgmt is not None
                                     else assume("management fee not published; 0.50% assumed on top of the published net yield", [0.0, 0.005, 0.01]))
    prov["income_share_fee_rate"] = doc("Fees are NAV-based where published", url, "low")
    prov["performance_fee_rate"] = doc(sp["perf_src"], url, "medium") if perf else assume("no performance fee published", [0.0, 0.10])
    prov["hurdle_rate_annual"] = assume("hurdle not published", [0.0, 0.06]) if perf else NA("no performance fee")
    exit_fee = sp.get("exit_fee", 0.0)
    prov["redemption_fee_rate"] = doc(sp["exit_src"], url, "medium") if exit_fee else assume("no redemption fee published", [0.0, 0.005])
    prov["redemption_fee_to_issuer_pct"] = assume("who receives the redemption fee is not disclosed", [0.0, 1.0]) if exit_fee else NA("no redemption fee")
    prov["platform_admin_fee_annual"] = COMMON_ASSUMPTIONS["platform_admin_fee_annual"][1]
    prov["fixed_operating_cost_annual"] = COMMON_ASSUMPTIONS["fixed_operating_cost_annual"][1]
    prov["variable_operating_cost_bps"] = COMMON_ASSUMPTIONS["variable_operating_cost_bps"][1]
    if sp["gate"] is None:
        prov["gate_max_pct_nav_per_period"] = doc(sp["gate_doc"], sp.get("gate_url", url), "medium")
    else:
        prov["gate_max_pct_nav_per_period"] = (assume(sp["gate_doc"], sorted({round(sp["gate"] / 2, 4), sp["gate"], round(min(1.0, sp["gate"] * 2), 4)}))
                                               if sp.get("gate_assumed") else doc(sp["gate_doc"], url, "medium"))
    prov["queue_pricing"] = assume("redemptions priced at the payment-date NAV", ["payment_date_nav", "request_date_nav"]) if not sp["tbill"] \
        else doc("Redemptions at NAV on the redemption date", url, "medium")
    prov["facility_max_capacity"] = doc("No fund-level liquidity facility documented", url, "low")
    prov["facility_interest_rate_annual"] = NA("no fund-level facility")
    prov["facility_commitment_fee_annual"] = NA("no fund-level facility")
    prov["secondary_required_return_annual"] = COMMON_ASSUMPTIONS["secondary_required_return_annual"][1]
    prov["secondary_illiquidity_premium"] = (assume("T-bill fund with daily or instant redemption", [0.0, 0.0025]) if sp["tbill"]
                                             else COMMON_ASSUMPTIONS["secondary_illiquidity_premium"][1])
    return {
        "design_id": sp["id"],
        "name": sp["name"],
        "short_label": sp["short"],
        "positioning": f"{sp['asset']}; {sp.get('gate_doc') or sp.get('lag_doc')}; {sp['notes']}.",
        "target_cash_buffer_pct": 0.0 if (sp["tbill"] or sp.get("fx")) else sp["buffer"],
        "distribution_policy": sp["policy"],
        "distribution_reinvestment_rate": None if sp["policy"] == "accumulating" else 1.0,
        "looped_share": round(sp["looped"], 4),
        "expected_annual_redemption_turnover": 0.12,
        "real_world": {"aum_fiat": sp["aum"], "holders": sp["holders"], "as_of": AS_OF, "source": url},
        "portfolio": {
            "name": sp["asset"],
            "gross_yield_annual": round(gross, 4),
            "capital_appreciation_annual": 0.0,
            "portfolio_expense_annual": 0.0,
            "settlement_lag_periods": sp["lag"],
            "liquidation_haircut_bps": sp["haircut"],
            "valuation_method": "stated_asset_valuation",
            "target_net_yield_annual": round(net, 4),
            "reward_token_enabled": False,
            "reward_token_annual_budget_fiat": 0.0,
        },
        "issuer": {
            "management_fee_annual": mgmt_value,
            "income_share_fee_rate": 0.0,
            "performance_fee_rate": perf,
            "hurdle_rate_annual": 0.0,
            "redemption_fee_rate": exit_fee,
            "redemption_fee_to_issuer_pct": 0.0,
            "platform_admin_fee_annual": 0.0,
            "platform_admin_cost_bearer": "portfolio",
            "fixed_operating_cost_annual": 210000.0,
            "variable_operating_cost_bps": 12.0,
        },
        "redemption_rules": {"gate_max_pct_nav_per_period": sp["gate"], "payment_sla_periods": 3, "queue_pricing": "payment_date_nav"},
        "liquidity_facility": {"max_capacity": 0.0, "interest_rate_annual": 0.0625, "commitment_fee_annual": 0.004, "cost_bearer": "portfolio"},
        "secondary_market": {
            "required_return_annual": 0.12,
            "illiquidity_premium": 0.0 if sp["tbill"] else 0.01,
            "max_discount": 0.35,
        },
        "provenance": prov,
    }, sp


cfg = copy.deepcopy(base)
cfg["case_study_id"] = "rwa-universe-v1"
cfg["calibration_date"] = AS_OF
cfg["title"] = "Tokenised RWA Universe: 17 Funds Listed on Solana Lending Venues plus Benchmarks"
cfg["subtitle"] = ("Investor returns, exit liquidity, looping and sponsor economics of 17 tokenised real-world-asset funds, "
                   "public terms as of 28 October 2026, normalised to $25M over 36 months.")
cfg["evidence_status"]["statement"] = (
    "Fund terms follow dated public sources recorded per parameter, as of 28 October 2026; the fund list and looped shares come "
    "from Kamino and Loopscale on-chain data read from a public Solana RPC. Parameters without a public source are flagged as "
    "assumptions and swept. All funds are simulated at a normalised $25M starting AUM over 36 months under nine synthetic "
    "scenarios; investor behaviour, stress shocks, credit-loss sensitivities and scenario probabilities are synthetic. Results "
    "describe these modelled structures, not the future performance of the named funds, and are not credit ratings or investment advice."
)

# Investor cohorts: add looped holders (sized per fund from on-chain data)
cfg["investor_cohorts"].append({
    "cohort_id": "looped", "name": "Looped Holders (token posted as collateral to borrow)", "initial_capital_share": 0.0,
    "num_holders": 50, "base_subscription_rate_period": 0.02, "distribution_reinvestment_rate": 1.0,
    "base_redemption_rate_period": 0.02, "target_net_yield_annual": 0.064, "return_shortfall_sensitivity": 2.0,
    "nav_drawdown_sensitivity": 4.0, "queue_delay_sensitivity": 0.8,
})

designs = {}
for d in ("buidl_treasury", "maple_syrup_usdc", "hamilton_lane_scope"):
    designs[d] = copy.deepcopy(base["product_designs"][d])
designs["maple_syrup_usdc"]["looped_share"] = round(54 / 967, 4)
designs["maple_syrup_usdc"]["provenance"]["looped_share"] = doc(ONCHAIN, "https://app.kamino.finance", "medium", note="share of total AUM", sweep=[0.0, 0.056, 0.2])
for d in ("buidl_treasury", "hamilton_lane_scope"):
    designs[d]["looped_share"] = 0.0
    designs[d]["provenance"]["looped_share"] = doc(ONCHAIN + " (none found)", "https://app.kamino.finance", "medium")
designs["maple_syrup_usdc"]["provenance"]["gross_yield_annual"]["note"] = (
    "rwa.xyz shows a lower NAV-accrual yield (30-day 3.6%, 7-day 1.6%) and a Yearn report cites an 8.33% fee; Maple's API and on-chain fee setting are used here")

specs = {}
provenance_list = []
for sp in SPECS:
    block, spec = fund_block(sp)
    designs[sp["id"]] = block
    specs[sp["id"]] = spec
    provenance_list.append({"design_id": sp["id"], "product_name": sp["name"], "ticker": sp["ticker"], "issuer": sp["issuer"],
                            "network_rail": sp["rail"], "issuer_and_infra": sp["issuer"], "asset_class": sp["asset"]})
cfg["product_designs"] = designs
cfg["real_world_provenance"] = base["real_world_provenance"] + provenance_list

# Credit-loss sensitivity per fund relative to the scenario's base write-down (synthetic)
beta = {"buidl_treasury": 0.0, "maple_syrup_usdc": 1.4, "hamilton_lane_scope": 0.8, **{k: v["credit_beta"] for k, v in specs.items()}}
liquid = {"buidl_treasury"} | {k for k, v in specs.items() if v["lag"] == 0}
scen = copy.deepcopy(base["scenarios"])
for s_id, s in scen.items():
    ov = s["overrides"]
    dov = ov.setdefault("design_overrides", {})
    sched = ov.get("capital_shock_schedule")
    for d in designs:
        e = dov.setdefault(d, {})
        if sched and d not in ("maple_syrup_usdc", "hamilton_lane_scope", "buidl_treasury"):
            if d in specs and specs[d].get("fx"):
                e["capital_shock_schedule"] = {m: -0.06 for m in sched}  # peso depreciation (synthetic)
            else:
                e["capital_shock_schedule"] = {m: round(v * beta[d], 4) for m, v in sched.items()} if beta[d] else {}
        if "settlement_lag_override" in ov and d in liquid and d != "buidl_treasury":
            e["settlement_lag_override"] = 0
            e["liquidation_haircut_bps_override"] = 50.0 if (d in specs and specs[d].get("fx")) else 8.0
        if not e:
            dov.pop(d)
scen["loop_unwind"] = {
    "scenario_id": "loop_unwind",
    "name": "9. Looping unwind (borrow-rate spike forces looped holders out)",
    "short_label": "Looping unwind",
    "description": ("Borrowing costs on Solana lending venues spike in Month 12: looped holders sell or redeem 60% of their "
                    "position, then another 20% in Month 13; everything else is as in the baseline, so the scenario isolates looping."),
    "overrides": {
        "participation_multiplier": 1.0,
        "redemption_multiplier": 1.0,
        "cohort_withdrawal_shocks": {12: {"looped": 0.60}, 13: {"looped": 0.20}},
    },
}
# Crypto basis (USCC): funding rates collapse in the rate-cut scenario; in the combined crisis the basis collapses
# and an exchange counterparty fails (synthetic)
scen["adverse_asset_return"]["overrides"]["design_overrides"].setdefault("uscc", {})["yield_delta_annual"] = -0.05
scen["combined_adverse"]["overrides"]["design_overrides"].setdefault("uscc", {}).update(
    {"yield_delta_annual": -0.06, "capital_shock_schedule": {12: -0.05}})
cfg["scenarios"] = scen
cfg["scenario_weights"]["loop_unwind"] = 0.05

mc = cfg["monte_carlo"]
mc["design_overrides"] = dict(mc.get("design_overrides", {}))
for d, sp in specs.items():
    if sp["tbill"]:
        mc["design_overrides"][d] = {"gross_yield_sd": 0.003, "stochastic_yield_volatility_annual": 0.002, "stochastic_capital_volatility_annual": 0.0}
    elif sp.get("fx"):
        mc["design_overrides"][d] = {"gross_yield_sd": 0.01, "stochastic_capital_volatility_annual": 0.12}  # MXN/USD volatility (synthetic)
    elif sp.get("basis"):
        mc["design_overrides"][d] = {"gross_yield_sd": 0.03, "stochastic_yield_volatility_annual": 0.03, "stochastic_capital_volatility_annual": 0.02}

out = f"{REPO}/src/TokenLab/agentic/data/rwa_universe_case_study.yaml"
header = ("# Generated by scripts/generate_rwa_universe_config.py from real_rwa_funds_case_study.yaml plus per-fund specs\n"
          "# (on-chain Kamino/Loopscale extraction and public sources, 2026-10-28). Edit the per-fund specs in that script and re-run it; do not edit this file by hand.\n")
with open(out, "w", encoding="utf-8") as f:
    f.write(header)
    yaml.safe_dump(cfg, f, sort_keys=False, allow_unicode=True, width=200)
print("designs:", len(designs), "scenarios:", len(scen))
