# -*- coding: utf-8 -*-
"""
Reusable economic model for tokenised investment products and asset-backed token economies.

Connects:
1. Underlying assets and cash flows (income, expenses, valuation changes, liquidation haircuts, settlement lags).
2. Token-holder claims (distinct tracking of underlying asset value, NAV per token, investor cash flows/returns,
   and executable redemption/sale price, plus extensible ValuationMethod hooks).
3. Issuer economics (management, performance, admin, and exit fees; fixed/variable operating costs;
   explicit cost-bearer attribution across portfolio, issuer, and exiting investor; break-even AUM scale).
4. Participant behaviour and product rules (multiple investor cohorts, concentration levels, subscriptions,
   distribution reinvestment, endogenous & scenario withdrawal behaviour, redemption gates, and optional
   traditional tokenomics reward overlays).
5. Liquidity and settlement (available cash, FIFO redemption queue, settlement delays, finite external
   liquidity facility, financing costs, and time-to-full-payment tracking).
"""

from __future__ import annotations

import copy
import math
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from .baseclasses import Controller, Initialisable, TokenEconomy
from ..utils.auditing import AuditableConfig


# ---------------------------------------------------------------------------
# 1. Extensible Valuation Methods
# ---------------------------------------------------------------------------


class ValuationMethod(Controller):
    """
    Extension point for asset-specific valuation methods.

    Subclasses compute the period valuation adjustment and carrying value of
    underlying non-cash investment assets based on explicit assumptions.
    """

    def __init__(self, name: str = "stated_asset_valuation") -> None:
        super().__init__()
        self.name = name

    def compute_asset_valuation_change(
        self,
        invested_assets: float,
        gross_yield_annual: float,
        capital_return_annual: float,
        periods_per_year: int,
        iteration: int,
        context: Optional[Dict[str, Any]] = None,
    ) -> Tuple[float, Dict[str, float]]:
        """
        Return (valuation_change_fiat, diagnostics_dict) for the current step.
        """
        raise NotImplementedError


class StatedAssetValuation(ValuationMethod):
    """
    Baseline valuation tied directly to stated asset values and explicit
    capital-return / mark-to-market assumptions.
    """

    def __init__(self, shock_schedule: Optional[Dict[int, float]] = None) -> None:
        super().__init__(name="stated_asset_valuation")
        self.shock_schedule: Dict[int, float] = dict(shock_schedule or {})

    def compute_asset_valuation_change(
        self,
        invested_assets: float,
        gross_yield_annual: float,
        capital_return_annual: float,
        periods_per_year: int,
        iteration: int,
        context: Optional[Dict[str, Any]] = None,
    ) -> Tuple[float, Dict[str, float]]:
        period_cap_rate = capital_return_annual / float(periods_per_year)
        discrete_shock = float(self.shock_schedule.get(iteration, 0.0))
        stochastic_shock = float((context or {}).get("stochastic_capital_shock", 0.0))
        effective_rate = period_cap_rate + discrete_shock + stochastic_shock
        valuation_change = invested_assets * effective_rate
        return valuation_change, {
            "effective_capital_return_period": effective_rate,
            "discrete_shock": discrete_shock,
            "stochastic_shock": stochastic_shock,
            "valuation_basis": invested_assets + valuation_change,
        }


class DiscountedCashFlowValuation(ValuationMethod):
    """
    Values underlying income-producing assets using a finite-horizon Discounted
    Cash Flow (DCF) annuity + terminal principal factor relative to par carrying value.
    """

    def __init__(
        self,
        discount_rate_annual: float = 0.08,
        projection_horizon_years: float = 3.0,
        shock_schedule: Optional[Dict[int, float]] = None,
    ) -> None:
        super().__init__(name="discounted_cash_flow_valuation")
        self.discount_rate_annual = float(discount_rate_annual)
        self.projection_horizon_years = float(projection_horizon_years)
        self.shock_schedule: Dict[int, float] = dict(shock_schedule or {})
        self._previous_pv_factor: float = 1.0

    def reset(self) -> None:
        self._previous_pv_factor = 1.0

    def compute_asset_valuation_change(
        self,
        invested_assets: float,
        gross_yield_annual: float,
        capital_return_annual: float,
        periods_per_year: int,
        iteration: int,
        context: Optional[Dict[str, Any]] = None,
    ) -> Tuple[float, Dict[str, float]]:
        spread_shock = float((context or {}).get("discount_rate_spread_shock", 0.0))
        effective_discount = max(0.005, self.discount_rate_annual + spread_shock - capital_return_annual)
        n_periods = max(1, int(round(self.projection_horizon_years * periods_per_year)))
        r_per = effective_discount / float(periods_per_year)
        c_per = gross_yield_annual / float(periods_per_year)
        if abs(r_per) < 1e-9:
            pv_factor = 1.0 + c_per * n_periods
        else:
            annuity = c_per * (1.0 - (1.0 + r_per) ** (-n_periods)) / r_per
            terminal = (1.0 + r_per) ** (-n_periods)
            pv_factor = annuity + terminal

        discrete_shock = float(self.shock_schedule.get(iteration, 0.0))
        stochastic_shock = float((context or {}).get("stochastic_capital_shock", 0.0))
        relative_change = (pv_factor / max(1e-9, self._previous_pv_factor)) - 1.0 + discrete_shock + stochastic_shock
        self._previous_pv_factor = pv_factor
        valuation_change = invested_assets * relative_change
        return valuation_change, {
            "effective_capital_return_period": relative_change,
            "dcf_pv_factor": pv_factor,
            "effective_discount_rate_annual": effective_discount,
            "valuation_basis": invested_assets + valuation_change,
        }


class HaircutStressValuation(ValuationMethod):
    """
    Applies a stress valuation haircut when redemption pressure or market stress
    crosses a configurable threshold.
    """

    def __init__(
        self,
        stress_haircut_bps: float = 150.0,
        queue_ratio_threshold: float = 0.05,
        shock_schedule: Optional[Dict[int, float]] = None,
    ) -> None:
        super().__init__(name="haircut_stress_valuation")
        self.stress_haircut_bps = float(stress_haircut_bps)
        self.queue_ratio_threshold = float(queue_ratio_threshold)
        self.shock_schedule: Dict[int, float] = dict(shock_schedule or {})
        self._haircut_active: bool = False

    def reset(self) -> None:
        self._haircut_active = False

    def compute_asset_valuation_change(
        self,
        invested_assets: float,
        gross_yield_annual: float,
        capital_return_annual: float,
        periods_per_year: int,
        iteration: int,
        context: Optional[Dict[str, Any]] = None,
    ) -> Tuple[float, Dict[str, float]]:
        ctx = context or {}
        period_cap_rate = capital_return_annual / float(periods_per_year)
        discrete_shock = float(self.shock_schedule.get(iteration, 0.0))
        stochastic_shock = float(ctx.get("stochastic_capital_shock", 0.0))
        queue_ratio = float(ctx.get("queue_to_nav_ratio", 0.0))
        haircut_rate = 0.0
        if queue_ratio >= self.queue_ratio_threshold and not self._haircut_active:
            haircut_rate = -(self.stress_haircut_bps / 10000.0)
            self._haircut_active = True
        elif queue_ratio < 0.5 * self.queue_ratio_threshold and self._haircut_active:
            haircut_rate = +(self.stress_haircut_bps / 10000.0)
            self._haircut_active = False

        effective_rate = period_cap_rate + discrete_shock + stochastic_shock + haircut_rate
        valuation_change = invested_assets * effective_rate
        return valuation_change, {
            "effective_capital_return_period": effective_rate,
            "stress_haircut_applied": haircut_rate,
            "valuation_basis": invested_assets + valuation_change,
        }


# ---------------------------------------------------------------------------
# 2. Underlying Assets, Cash Flows, and Settlement Receivables
# ---------------------------------------------------------------------------


@dataclass
class PendingAssetSettlement:
    """Represents an initiated asset liquidation awaiting underlying settlement."""

    initiated_iteration: int
    maturity_iteration: int
    gross_assets_sold: float
    haircut_loss_fiat: float
    net_cash_proceeds: float


class AssetPortfolioController(Controller):
    """
    Models the underlying investment portfolio, cash buffer, income generation,
    portfolio-borne operating expenses, valuation adjustments, and delayed
    underlying asset liquidation.
    """

    def __init__(
        self,
        initial_aum: float = 25_000_000.0,
        target_cash_buffer_pct: float = 0.08,
        gross_yield_annual: float = 0.085,
        capital_appreciation_annual: float = 0.0,
        portfolio_expense_annual: float = 0.0020,
        settlement_lag_periods: int = 1,
        liquidation_haircut_bps: float = 35.0,
        periods_per_year: int = 12,
        valuation_method: Optional[ValuationMethod] = None,
    ) -> None:
        super().__init__()
        self.initial_aum = float(initial_aum)
        self.target_cash_buffer_pct = float(target_cash_buffer_pct)
        self.gross_yield_annual = float(gross_yield_annual)
        self.capital_appreciation_annual = float(capital_appreciation_annual)
        self.portfolio_expense_annual = float(portfolio_expense_annual)
        self.settlement_lag_periods = max(0, int(settlement_lag_periods))
        self.liquidation_haircut_bps = max(0.0, float(liquidation_haircut_bps))
        self.periods_per_year = max(1, int(periods_per_year))
        self.valuation_method: ValuationMethod = valuation_method or StatedAssetValuation()
        self.reset()

    def reset(self) -> None:
        self.portfolio_cash: float = self.initial_aum * self.target_cash_buffer_pct
        self.invested_assets: float = self.initial_aum - self.portfolio_cash
        self.pending_settlements: List[PendingAssetSettlement] = []

        self.gross_income_period: float = 0.0
        self.portfolio_expense_period: float = 0.0
        self.unrealized_valuation_change_period: float = 0.0
        self.realized_liquidation_loss_period: float = 0.0
        self.settled_asset_sales_period: float = 0.0
        self.initiated_asset_sales_gross_period: float = 0.0
        self.new_investments_period: float = 0.0

        self.cumulative_gross_income: float = 0.0
        self.cumulative_portfolio_expense: float = 0.0
        self.cumulative_unrealized_valuation_change: float = 0.0
        self.cumulative_realized_liquidation_loss: float = 0.0
        if hasattr(self.valuation_method, "reset"):
            self.valuation_method.reset()

    @property
    def pending_settlement_receivables(self) -> float:
        """Total net cash receivable from initiated asset sales still in settlement transit."""
        return float(sum(item.net_cash_proceeds for item in self.pending_settlements))

    @property
    def underlying_asset_value(self) -> float:
        """Total gross underlying asset value (invested assets + cash + settlement receivables)."""
        return float(self.invested_assets + self.portfolio_cash + self.pending_settlement_receivables)

    def begin_period(self, iteration: int) -> float:
        """Reset per-period flow counters and mature any receivables due at `iteration`."""
        self.gross_income_period = 0.0
        self.portfolio_expense_period = 0.0
        self.unrealized_valuation_change_period = 0.0
        self.realized_liquidation_loss_period = 0.0
        self.settled_asset_sales_period = 0.0
        self.initiated_asset_sales_gross_period = 0.0
        self.new_investments_period = 0.0

        still_pending: List[PendingAssetSettlement] = []
        matured_cash = 0.0
        for item in self.pending_settlements:
            if item.maturity_iteration <= iteration:
                matured_cash += item.net_cash_proceeds
            else:
                still_pending.append(item)
        self.pending_settlements = still_pending
        self.portfolio_cash += matured_cash
        self.settled_asset_sales_period += matured_cash
        return matured_cash

    def accrue_income_and_valuation(
        self,
        iteration: int,
        yield_override_annual: Optional[float] = None,
        capital_return_override_annual: Optional[float] = None,
        valuation_context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, float]:
        """Accrue cash investment income, valuation changes, and portfolio operating expenses."""
        eff_yield = self.gross_yield_annual if yield_override_annual is None else float(yield_override_annual)
        eff_cap = (
            self.capital_appreciation_annual
            if capital_return_override_annual is None
            else float(capital_return_override_annual)
        )

        # Record opening asset base before current-period income for standard fund expense accrual
        opening_gross_basis = self.underlying_asset_value

        # 1. Valuation change on invested assets (mark-to-market / DCF / stress adjustment)
        val_change, val_diag = self.valuation_method.compute_asset_valuation_change(
            invested_assets=self.invested_assets,
            gross_yield_annual=eff_yield,
            capital_return_annual=eff_cap,
            periods_per_year=self.periods_per_year,
            iteration=iteration,
            context=valuation_context,
        )
        # Prevent invested assets from dropping below zero
        if self.invested_assets + val_change < 0.0:
            val_change = -self.invested_assets
        self.invested_assets += val_change
        self.unrealized_valuation_change_period = val_change
        self.cumulative_unrealized_valuation_change += val_change

        # 2. Cash income generated by invested assets
        gross_income = max(0.0, self.invested_assets * (eff_yield / float(self.periods_per_year)))
        self.portfolio_cash += gross_income
        self.gross_income_period = gross_income
        self.cumulative_gross_income += gross_income

        # 3. Portfolio-borne operating expenses (custody, audit, SPV administration) on opening asset base
        portfolio_exp = max(
            0.0,
            (opening_gross_basis + val_change) * (self.portfolio_expense_annual / float(self.periods_per_year)),
        )
        paid_exp = min(self.portfolio_cash, portfolio_exp)
        self.portfolio_cash -= paid_exp
        self.portfolio_expense_period = paid_exp
        self.cumulative_portfolio_expense += paid_exp

        return {
            "gross_income": gross_income,
            "unrealized_valuation_change": val_change,
            "portfolio_expense": paid_exp,
            "unpaid_portfolio_expense": max(0.0, portfolio_exp - paid_exp),
            **val_diag,
        }

    def initiate_asset_sale(
        self,
        target_net_cash: float,
        iteration: int,
        settlement_lag_override: Optional[int] = None,
        haircut_bps_override: Optional[float] = None,
    ) -> Dict[str, float]:
        """
        Liquidate underlying `invested_assets` to raise `target_net_cash`.

        Distinguishes:
        - `haircut_loss`: permanent loss of NAV due to liquidation discount (`liquidation_haircut_bps`).
        - `settlement_lag`: temporary delay (`settlement_lag_periods`) before net proceeds
          become liquid `portfolio_cash`. During the lag, `net_cash_proceeds` sits in
          `pending_settlement_receivables`, preserving NAV while constraining immediate cash.
        """
        if target_net_cash <= 1e-9 or self.invested_assets <= 1e-9:
            return {"gross_sold": 0.0, "haircut_loss": 0.0, "net_proceeds": 0.0, "settled_immediately": 0.0}

        lag = self.settlement_lag_periods if settlement_lag_override is None else max(0, int(settlement_lag_override))
        haircut_bps = (
            self.liquidation_haircut_bps if haircut_bps_override is None else max(0.0, float(haircut_bps_override))
        )
        haircut_rate = min(0.95, haircut_bps / 10000.0)

        required_gross = target_net_cash / max(1e-9, (1.0 - haircut_rate))
        gross_sold = min(self.invested_assets, required_gross)
        haircut_loss = gross_sold * haircut_rate
        net_proceeds = gross_sold - haircut_loss

        self.invested_assets -= gross_sold
        self.initiated_asset_sales_gross_period += gross_sold
        self.realized_liquidation_loss_period += haircut_loss
        self.cumulative_realized_liquidation_loss += haircut_loss

        if lag == 0:
            self.portfolio_cash += net_proceeds
            self.settled_asset_sales_period += net_proceeds
            return {
                "gross_sold": gross_sold,
                "haircut_loss": haircut_loss,
                "net_proceeds": net_proceeds,
                "settled_immediately": net_proceeds,
            }
        else:
            self.pending_settlements.append(
                PendingAssetSettlement(
                    initiated_iteration=iteration,
                    maturity_iteration=iteration + lag,
                    gross_assets_sold=gross_sold,
                    haircut_loss_fiat=haircut_loss,
                    net_cash_proceeds=net_proceeds,
                )
            )
            return {
                "gross_sold": gross_sold,
                "haircut_loss": haircut_loss,
                "net_proceeds": net_proceeds,
                "settled_immediately": 0.0,
            }

    def deploy_excess_cash(self, min_cash_to_keep: float) -> float:
        """Deploy cash above `min_cash_to_keep` into `invested_assets` at par."""
        deployable = max(0.0, self.portfolio_cash - max(0.0, min_cash_to_keep))
        if deployable > 1e-9:
            self.portfolio_cash -= deployable
            self.invested_assets += deployable
            self.new_investments_period += deployable
        return deployable


# ---------------------------------------------------------------------------
# 3. External Liquidity Facility
# ---------------------------------------------------------------------------


class ExternalLiquidityFacility(Controller):
    """
    Finite external credit / repo / liquidity facility supporting redemptions.

    Explicitly tracks draws, repayments, available capacity, interest expense,
    commitment fees, and whether financing costs are borne by the `"portfolio"`
    or the `"issuer"`.
    """

    def __init__(
        self,
        max_capacity: float = 0.0,
        interest_rate_annual: float = 0.064,
        commitment_fee_annual: float = 0.005,
        cost_bearer: str = "portfolio",
        periods_per_year: int = 12,
    ) -> None:
        super().__init__()
        if cost_bearer not in ("portfolio", "issuer"):
            raise ValueError("ExternalLiquidityFacility cost_bearer must be 'portfolio' or 'issuer'.")
        self.base_max_capacity = max(0.0, float(max_capacity))
        self.max_capacity = self.base_max_capacity
        self.interest_rate_annual = max(0.0, float(interest_rate_annual))
        self.commitment_fee_annual = max(0.0, float(commitment_fee_annual))
        self.cost_bearer = cost_bearer
        self.periods_per_year = max(1, int(periods_per_year))
        self.reset()

    def reset(self) -> None:
        self.max_capacity = self.base_max_capacity
        self.drawn_balance: float = 0.0
        self.drawn_period: float = 0.0
        self.repaid_period: float = 0.0
        self.interest_expense_period: float = 0.0
        self.commitment_fee_period: float = 0.0
        self.cumulative_interest_expense: float = 0.0
        self.cumulative_commitment_fee: float = 0.0
        self.cumulative_drawn: float = 0.0
        self.cumulative_repaid: float = 0.0

    @property
    def available_capacity(self) -> float:
        return max(0.0, self.max_capacity - self.drawn_balance)

    @property
    def total_financing_cost_period(self) -> float:
        return self.interest_expense_period + self.commitment_fee_period

    @property
    def cumulative_financing_cost(self) -> float:
        return self.cumulative_interest_expense + self.cumulative_commitment_fee

    def begin_period(self, capacity_multiplier: float = 1.0) -> None:
        self.max_capacity = self.base_max_capacity * max(0.0, float(capacity_multiplier))
        self.drawn_period = 0.0
        self.repaid_period = 0.0
        self.interest_expense_period = 0.0
        self.commitment_fee_period = 0.0

    def accrue_financing_costs(self) -> Tuple[float, float]:
        """Compute period interest on drawn balance and commitment fee on undrawn balance."""
        interest = self.drawn_balance * (self.interest_rate_annual / float(self.periods_per_year))
        undrawn = max(0.0, self.max_capacity - self.drawn_balance)
        commitment = undrawn * (self.commitment_fee_annual / float(self.periods_per_year))
        self.interest_expense_period = interest
        self.commitment_fee_period = commitment
        self.cumulative_interest_expense += interest
        self.cumulative_commitment_fee += commitment
        return interest, commitment

    def draw(self, requested_amount: float) -> float:
        """Borrow up to available facility capacity."""
        if requested_amount <= 1e-9 or self.available_capacity <= 1e-9:
            return 0.0
        actual_draw = min(requested_amount, self.available_capacity)
        self.drawn_balance += actual_draw
        self.drawn_period += actual_draw
        self.cumulative_drawn += actual_draw
        return actual_draw

    def repay(self, available_cash: float) -> float:
        """Repay drawn principal using available cash."""
        if available_cash <= 1e-9 or self.drawn_balance <= 1e-9:
            return 0.0
        actual_repay = min(available_cash, self.drawn_balance)
        self.drawn_balance -= actual_repay
        self.repaid_period += actual_repay
        self.cumulative_repaid += actual_repay
        return actual_repay


# ---------------------------------------------------------------------------
# 4. Issuer Economics & Cost Attribution
# ---------------------------------------------------------------------------


class IssuerEconomicsController(Controller):
    """
    Models issuer/manager fee revenue, operating expenditure, profitability,
    and break-even AUM scale, with explicit party attribution for every cost.
    """

    def __init__(
        self,
        management_fee_annual: float = 0.0075,
        performance_fee_rate: float = 0.10,
        hurdle_rate_annual: float = 0.05,
        redemption_fee_rate: float = 0.005,
        redemption_fee_to_issuer_pct: float = 0.0,
        platform_admin_fee_annual: float = 0.0010,
        platform_admin_cost_bearer: str = "portfolio",
        fixed_operating_cost_annual: float = 240_000.0,
        variable_operating_cost_bps: float = 15.0,
        periods_per_year: int = 12,
    ) -> None:
        super().__init__()
        if platform_admin_cost_bearer not in ("portfolio", "issuer"):
            raise ValueError("platform_admin_cost_bearer must be 'portfolio' or 'issuer'.")
        self.management_fee_annual = max(0.0, float(management_fee_annual))
        self.performance_fee_rate = max(0.0, min(1.0, float(performance_fee_rate)))
        self.hurdle_rate_annual = max(0.0, float(hurdle_rate_annual))
        self.redemption_fee_rate = max(0.0, min(0.5, float(redemption_fee_rate)))
        self.redemption_fee_to_issuer_pct = max(0.0, min(1.0, float(redemption_fee_to_issuer_pct)))
        self.platform_admin_fee_annual = max(0.0, float(platform_admin_fee_annual))
        self.platform_admin_cost_bearer = platform_admin_cost_bearer
        self.fixed_operating_cost_annual = max(0.0, float(fixed_operating_cost_annual))
        self.variable_operating_cost_bps = max(0.0, float(variable_operating_cost_bps))
        self.periods_per_year = max(1, int(periods_per_year))
        self.reset()

    def reset(self) -> None:
        self.high_water_mark_nav_per_token: float = 1.0
        self.mgmt_fee_period: float = 0.0
        self.perf_fee_period: float = 0.0
        self.exit_fee_issuer_period: float = 0.0
        self.exit_fee_portfolio_period: float = 0.0
        self.admin_fee_period: float = 0.0
        self.fixed_op_cost_period: float = 0.0
        self.variable_op_cost_period: float = 0.0
        self.facility_cost_issuer_period: float = 0.0

        self.issuer_revenue_period: float = 0.0
        self.issuer_cost_period: float = 0.0
        self.issuer_profit_period: float = 0.0

        self.cumulative_mgmt_fee: float = 0.0
        self.cumulative_perf_fee: float = 0.0
        self.cumulative_exit_fee_issuer: float = 0.0
        self.cumulative_exit_fee_portfolio: float = 0.0
        self.cumulative_admin_fee_portfolio: float = 0.0
        self.cumulative_issuer_revenue: float = 0.0
        self.cumulative_issuer_cost: float = 0.0
        self.cumulative_issuer_profit: float = 0.0

    def get_cost_attribution_schedule(self, facility_cost_bearer: str) -> List[Dict[str, str]]:
        """Explicit schedule stating who bears each fee/cost and who receives it."""
        return [
            {
                "item": "Management Fee",
                "borne_by": "portfolio",
                "received_by": "issuer",
                "rate_description": f"{self.management_fee_annual * 100:.2f}% p.a. of NAV",
            },
            {
                "item": "Performance Fee",
                "borne_by": "portfolio",
                "received_by": "issuer",
                "rate_description": (
                    f"{self.performance_fee_rate * 100:.1f}% above "
                    f"{self.hurdle_rate_annual * 100:.2f}% p.a. hurdle"
                ),
            },
            {
                "item": "Redemption / Anti-Dilution Exit Fee",
                "borne_by": "exiting_investor",
                "received_by": (
                    f"issuer ({self.redemption_fee_to_issuer_pct * 100:.0f}%) / "
                    f"portfolio ({(1.0 - self.redemption_fee_to_issuer_pct) * 100:.0f}%)"
                ),
                "rate_description": f"{self.redemption_fee_rate * 100:.2f}% of gross redemption claim",
            },
            {
                "item": "Platform & Tokenisation Admin Fee",
                "borne_by": self.platform_admin_cost_bearer,
                "received_by": "external_platform_provider",
                "rate_description": f"{self.platform_admin_fee_annual * 100:.2f}% p.a. of NAV",
            },
            {
                "item": "Liquidity Facility Interest & Commitment Fee",
                "borne_by": facility_cost_bearer,
                "received_by": "external_liquidity_provider",
                "rate_description": "Committed credit line interest + undrawn fee",
            },
            {
                "item": "Issuer Fixed & Variable Operating Costs",
                "borne_by": "issuer",
                "received_by": "issuer_operations_staff_compliance",
                "rate_description": (
                    f"${self.fixed_operating_cost_annual:,.0f}/yr fixed + "
                    f"{self.variable_operating_cost_bps:.1f} bps/yr variable"
                ),
            },
        ]

    def compute_breakeven_aum(
        self,
        expected_gross_portfolio_return_annual: float = 0.085,
        portfolio_expense_annual: float = 0.0020,
        expected_annual_redemption_turnover: float = 0.12,
        facility_max_capacity: float = 0.0,
        facility_commitment_fee_annual: float = 0.0,
        facility_cost_bearer: str = "portfolio",
    ) -> Dict[str, Any]:
        """
        Calculate analytical break-even AUM ($A_{\\text{BE}}$) required for the
        issuer's recurring net fee contribution margin to cover fixed costs.
        """
        net_pre_perf_return = (
            expected_gross_portfolio_return_annual
            - portfolio_expense_annual
            - self.management_fee_annual
            - (self.platform_admin_fee_annual if self.platform_admin_cost_bearer == "portfolio" else 0.0)
        )
        expected_perf_fee_rate_of_aum = (
            max(0.0, net_pre_perf_return - self.hurdle_rate_annual) * self.performance_fee_rate
        )
        expected_exit_fee_rate_of_aum = (
            expected_annual_redemption_turnover * self.redemption_fee_rate * self.redemption_fee_to_issuer_pct
        )
        gross_revenue_margin_rate = (
            self.management_fee_annual + expected_perf_fee_rate_of_aum + expected_exit_fee_rate_of_aum
        )

        issuer_var_cost_rate = (self.variable_operating_cost_bps / 10000.0) + (
            self.platform_admin_fee_annual if self.platform_admin_cost_bearer == "issuer" else 0.0
        )
        net_contribution_margin_rate = gross_revenue_margin_rate - issuer_var_cost_rate

        fixed_cost_total = self.fixed_operating_cost_annual + (
            facility_max_capacity * facility_commitment_fee_annual if facility_cost_bearer == "issuer" else 0.0
        )

        if net_contribution_margin_rate <= 1e-9:
            return {
                "breakeven_aum": 1_000_000_000.0,
                "is_achievable": False,
                "gross_revenue_margin_bps": gross_revenue_margin_rate * 10000.0,
                "issuer_variable_cost_bps": issuer_var_cost_rate * 10000.0,
                "net_contribution_margin_bps": net_contribution_margin_rate * 10000.0,
                "fixed_annual_costs_fiat": fixed_cost_total,
            }

        breakeven_aum = fixed_cost_total / net_contribution_margin_rate
        return {
            "breakeven_aum": float(breakeven_aum),
            "is_achievable": True,
            "gross_revenue_margin_bps": gross_revenue_margin_rate * 10000.0,
            "issuer_variable_cost_bps": issuer_var_cost_rate * 10000.0,
            "net_contribution_margin_bps": net_contribution_margin_rate * 10000.0,
            "fixed_annual_costs_fiat": fixed_cost_total,
        }


# ---------------------------------------------------------------------------
# 5. FIFO Redemption Queue & Settlement Obligation Tracker
# ---------------------------------------------------------------------------


@dataclass
class RedemptionTicket:
    """
    A single investor redemption request in the settlement queue.

    Tracks when the request was submitted, the gross NAV claim, the exit fee
    charged to the exiting investor, the net cash obligation owed, how much
    has been paid so far, and the iteration when the obligation was fully settled.
    """

    ticket_id: int
    cohort_id: str
    request_iteration: int
    shares_tendered: float
    nav_per_token_at_request: float
    gross_claim_fiat: float
    exit_fee_fiat: float
    net_claim_fiat: float
    paid_fiat: float = 0.0
    settled_iteration: Optional[int] = None

    @property
    def remaining_fiat(self) -> float:
        return max(0.0, self.net_claim_fiat - self.paid_fiat)

    @property
    def is_settled(self) -> bool:
        return self.remaining_fiat <= 1e-7


class RedemptionQueueManager(Controller):
    """
    Manages redemption requests, redemption gates, FIFO cash settlement, and
    time-to-full-payment metrics.
    """

    def __init__(
        self,
        gate_max_pct_nav_per_period: Optional[float] = None,
        payment_sla_periods: int = 3,
    ) -> None:
        super().__init__()
        self.gate_max_pct_nav_per_period = (
            None if gate_max_pct_nav_per_period is None else max(0.0, float(gate_max_pct_nav_per_period))
        )
        self.payment_sla_periods = max(0, int(payment_sla_periods))
        self.reset()

    def reset(self) -> None:
        self._next_ticket_id: int = 1
        self.tickets: List[RedemptionTicket] = []
        self.requests_gross_period: float = 0.0
        self.requests_net_period: float = 0.0
        self.requests_shares_period: float = 0.0
        self.exit_fees_period: float = 0.0
        self.payments_period: float = 0.0
        self.gate_cap_fiat_period: float = float("inf")
        self.gate_binding_period: bool = False

        self.cumulative_requests_gross: float = 0.0
        self.cumulative_requests_net: float = 0.0
        self.cumulative_payments: float = 0.0
        self.cumulative_exit_fees: float = 0.0

    def begin_period(self) -> None:
        self.requests_gross_period = 0.0
        self.requests_net_period = 0.0
        self.requests_shares_period = 0.0
        self.exit_fees_period = 0.0
        self.payments_period = 0.0
        self.gate_cap_fiat_period = float("inf")
        self.gate_binding_period = False

    @property
    def unpaid_obligations_fiat(self) -> float:
        return float(sum(t.remaining_fiat for t in self.tickets if not t.is_settled))

    @property
    def unpaid_tickets_count(self) -> int:
        return sum(1 for t in self.tickets if not t.is_settled)

    def submit_redemption(
        self,
        cohort_id: str,
        shares_tendered: float,
        nav_per_token: float,
        redemption_fee_rate: float,
        iteration: int,
    ) -> RedemptionTicket:
        """
        Record a redemption tender.

        Tokens are tendered (`shares_tendered`) and converted into a fixed net cash
        redemption obligation (`net_claim_fiat`), while the exit fee (`exit_fee_fiat`)
        is borne by the exiting investor. No cash is marked as paid until `settle_queue`
        executes against actual available liquidity.
        """
        gross_claim = max(0.0, shares_tendered * nav_per_token)
        exit_fee = gross_claim * max(0.0, min(0.5, redemption_fee_rate))
        net_claim = gross_claim - exit_fee

        ticket = RedemptionTicket(
            ticket_id=self._next_ticket_id,
            cohort_id=cohort_id,
            request_iteration=iteration,
            shares_tendered=shares_tendered,
            nav_per_token_at_request=nav_per_token,
            gross_claim_fiat=gross_claim,
            exit_fee_fiat=exit_fee,
            net_claim_fiat=net_claim,
        )
        self._next_ticket_id += 1
        self.tickets.append(ticket)

        self.requests_gross_period += gross_claim
        self.requests_net_period += net_claim
        self.requests_shares_period += shares_tendered
        self.exit_fees_period += exit_fee

        self.cumulative_requests_gross += gross_claim
        self.cumulative_requests_net += net_claim
        self.cumulative_exit_fees += exit_fee
        return ticket

    def settle_queue(
        self,
        available_cash: float,
        reference_nav_for_gate: float,
        iteration: int,
    ) -> Tuple[float, Dict[str, float]]:
        """
        Pay open redemption tickets in strict FIFO order, respecting both
        `available_cash` and any product-level redemption gate (`gate_max_pct_nav_per_period`).
        """
        total_due = self.unpaid_obligations_fiat
        if total_due <= 1e-9:
            return 0.0, {}

        if self.gate_max_pct_nav_per_period is not None:
            gate_cap = max(0.0, reference_nav_for_gate * self.gate_max_pct_nav_per_period)
            self.gate_cap_fiat_period = gate_cap
            if total_due > gate_cap + 1e-6:
                self.gate_binding_period = True
            max_payout = min(available_cash, gate_cap)
        else:
            self.gate_cap_fiat_period = float("inf")
            max_payout = available_cash

        remaining_budget = max(0.0, max_payout)
        total_paid = 0.0
        cohort_paid: Dict[str, float] = {}

        for ticket in self.tickets:
            if ticket.is_settled:
                continue
            if remaining_budget <= 1e-9:
                break
            needed = ticket.remaining_fiat
            pay = min(needed, remaining_budget)
            ticket.paid_fiat += pay
            remaining_budget -= pay
            total_paid += pay
            cohort_paid[ticket.cohort_id] = cohort_paid.get(ticket.cohort_id, 0.0) + pay
            if ticket.is_settled:
                ticket.settled_iteration = iteration

        self.payments_period += total_paid
        self.cumulative_payments += total_paid
        return total_paid, cohort_paid

    def compute_settlement_metrics(self, current_iteration: int) -> Dict[str, Any]:
        """Compute time-to-full-payment, open backlog age, and SLA compliance metrics."""
        if not self.tickets:
            return {
                "max_time_to_payment_periods": 0.0,
                "weighted_avg_time_to_payment_periods": 0.0,
                "open_queue_max_age_periods": 0.0,
                "sla_breach_count": 0,
                "sla_met": True,
            }

        waits: List[float] = []
        weights: List[float] = []
        open_ages: List[float] = []
        sla_breaches = 0

        for ticket in self.tickets:
            if ticket.net_claim_fiat <= 1e-9:
                continue
            if ticket.is_settled and ticket.settled_iteration is not None:
                wait = float(ticket.settled_iteration - ticket.request_iteration)
            else:
                # Ticket is still unpaid at `current_iteration` (at least 1 period of unresolved wait)
                wait = float((current_iteration - ticket.request_iteration) + 1)
                open_ages.append(wait)
            waits.append(wait)
            weights.append(ticket.net_claim_fiat)
            if wait > float(self.payment_sla_periods):
                sla_breaches += 1

        max_wait = max(waits) if waits else 0.0
        w_avg = float(np.average(waits, weights=weights)) if weights and sum(weights) > 0 else 0.0
        max_open_age = max(open_ages) if open_ages else 0.0

        return {
            "max_time_to_payment_periods": max_wait,
            "weighted_avg_time_to_payment_periods": w_avg,
            "open_queue_max_age_periods": max_open_age,
            "sla_breach_count": sla_breaches,
            "sla_met": sla_breaches == 0,
        }


# ---------------------------------------------------------------------------
# 6. Investor Cohort Behaviour
# ---------------------------------------------------------------------------


class InvestorCohort(Controller):
    """
    Represents a distinct investor group (e.g., Institutional, HNW, Retail)
    with configurable concentration, inflows, distribution reinvestment, and
    endogenous + shock-driven withdrawal behaviour.
    """

    def __init__(
        self,
        cohort_id: str,
        name: str,
        initial_capital: float,
        num_holders: int = 10,
        base_subscription_rate_period: float = 0.015,
        distribution_reinvestment_rate: float = 0.25,
        base_redemption_rate_period: float = 0.010,
        target_net_yield_annual: float = 0.064,
        return_shortfall_sensitivity: float = 0.80,
        nav_drawdown_sensitivity: float = 1.50,
        queue_delay_sensitivity: float = 0.35,
        shock_redemption_schedule: Optional[Dict[int, float]] = None,
    ) -> None:
        super().__init__()
        self.cohort_id = cohort_id
        self.name = name
        self.initial_capital = max(0.0, float(initial_capital))
        self.num_holders = max(1, int(num_holders))
        self.base_subscription_rate_period = max(0.0, float(base_subscription_rate_period))
        self.distribution_reinvestment_rate = max(0.0, min(1.0, float(distribution_reinvestment_rate)))
        self.base_redemption_rate_period = max(0.0, min(1.0, float(base_redemption_rate_period)))
        self.target_net_yield_annual = float(target_net_yield_annual)
        self.return_shortfall_sensitivity = max(0.0, float(return_shortfall_sensitivity))
        self.nav_drawdown_sensitivity = max(0.0, float(nav_drawdown_sensitivity))
        self.queue_delay_sensitivity = max(0.0, float(queue_delay_sensitivity))
        self.shock_redemption_schedule: Dict[int, float] = dict(shock_redemption_schedule or {})
        self.reset(initial_nav_per_token=1.0)

    def reset(self, initial_nav_per_token: float = 1.0) -> None:
        self.active_shares: float = self.initial_capital / max(1e-9, initial_nav_per_token)
        self.queued_shares_cumulative: float = 0.0
        self.cumulative_capital_invested: float = self.initial_capital
        self.cumulative_new_subscriptions_fiat: float = 0.0
        self.cumulative_distributions_cash_fiat: float = 0.0
        self.cumulative_distributions_reinvested_fiat: float = 0.0
        self.cumulative_redemption_claims_net_fiat: float = 0.0
        self.cumulative_redemptions_received_cash_fiat: float = 0.0
        self.cumulative_exit_fees_borne_fiat: float = 0.0
        self.reward_tokens_earned: float = 0.0

        self.subscriptions_fiat_period: float = 0.0
        self.distributions_cash_period: float = 0.0
        self.distributions_reinvested_period: float = 0.0
        self.redemptions_requested_shares_period: float = 0.0
        self.redemptions_requested_net_fiat_period: float = 0.0
        self.redemptions_paid_cash_period: float = 0.0

    def compute_desired_subscription_fiat(
        self,
        current_nav_per_token: float,
        realized_net_yield_annual: float,
        queue_open_ratio: float,
        participation_multiplier: float = 1.0,
    ) -> float:
        """Compute new cash subscriptions from this cohort for the period."""
        current_holding_value = self.active_shares * current_nav_per_token
        # Inflows slow down if there is an unpaid redemption queue or NAV drawdown
        confidence_factor = max(0.0, 1.0 - 2.0 * queue_open_ratio - max(0.0, 1.0 - current_nav_per_token) * 3.0)
        yield_bonus = max(-0.5, min(0.5, (realized_net_yield_annual - self.target_net_yield_annual) * 5.0))
        effective_sub_rate = (
            self.base_subscription_rate_period
            * max(0.0, participation_multiplier)
            * confidence_factor
            * (1.0 + yield_bonus)
        )
        return max(0.0, current_holding_value * effective_sub_rate)

    def compute_desired_redemption_fraction(
        self,
        iteration: int,
        current_nav_per_token: float,
        realized_net_yield_annual: float,
        queue_open_ratio: float,
        redemption_multiplier: float = 1.0,
        extra_shock_fraction: float = 0.0,
        reward_token_yield_boost_annual: float = 0.0,
    ) -> float:
        """
        Compute the fraction of `active_shares` this cohort wishes to redeem in `iteration`.

        Combines:
        1. Baseline liquidity turnover (`base_redemption_rate_period * redemption_multiplier`)
        2. Yield shortfall response (`return_shortfall_sensitivity * max(0, target - effective_yield)`)
        3. NAV drawdown response (`nav_drawdown_sensitivity * max(0, 1.0 - nav_per_token)`)
        4. Queue run contagion (`queue_delay_sensitivity * queue_open_ratio`)
        5. Explicit scenario/cohort withdrawal shocks (`shock_redemption_schedule[iteration] + extra_shock_fraction`)
        """
        effective_yield = realized_net_yield_annual + reward_token_yield_boost_annual
        yield_shortfall = max(0.0, self.target_net_yield_annual - effective_yield)
        nav_drawdown = max(0.0, 1.0 - current_nav_per_token)

        endogenous_rate = (
            self.base_redemption_rate_period * max(0.0, redemption_multiplier)
            + (self.return_shortfall_sensitivity * yield_shortfall / 12.0)
            + (self.nav_drawdown_sensitivity * nav_drawdown / 12.0)
            + (self.queue_delay_sensitivity * min(1.0, queue_open_ratio) / 12.0)
        )
        scheduled_shock = float(self.shock_redemption_schedule.get(iteration, 0.0)) + float(extra_shock_fraction)
        return max(0.0, min(0.65, endogenous_rate + scheduled_shock))


# ---------------------------------------------------------------------------
# 7. TokenisedProductEconomy (Main Reusable Product Engine)
# ---------------------------------------------------------------------------


class TokenisedProductEconomy(TokenEconomy, AuditableConfig):
    """
    Complete, reusable economic model for a tokenised investment product or RWA fund.

    Preserves compatibility with TokenLab's `TokenEconomy` and `AuditableConfig`
    interfaces while modeling asset cash flows, NAV vs. executable price, issuer
    P&L, multi-cohort investor behaviour, redemption queues, settlement delays,
    and external liquidity facilities.
    """

    def __init__(
        self,
        name: str = "Tokenised Income Fund",
        portfolio: Optional[AssetPortfolioController] = None,
        issuer: Optional[IssuerEconomicsController] = None,
        facility: Optional[ExternalLiquidityFacility] = None,
        redemption_queue: Optional[RedemptionQueueManager] = None,
        cohorts: Optional[List[InvestorCohort]] = None,
        distribution_policy: str = "full_net_income",
        target_distribution_yield_annual: float = 0.064,
        initial_nav_per_token: float = 1.0,
        secondary_discount_sensitivity: float = 0.50,
        min_liquidity_buffer_pct_nav: float = 0.03,
        reward_token_enabled: bool = False,
        reward_token_annual_budget_fiat: float = 0.0,
        scenario_overrides: Optional[Dict[str, Any]] = None,
        random_seed: Optional[int] = None,
    ) -> None:
        self.portfolio = portfolio or AssetPortfolioController()
        self.issuer = issuer or IssuerEconomicsController()
        self.facility = facility or ExternalLiquidityFacility()
        self.redemption_queue = redemption_queue or RedemptionQueueManager()
        super().__init__(
            holding_time=1.0,
            supply=self.portfolio.initial_aum / max(1e-9, float(initial_nav_per_token)),
            fiat="$",
            token="FUND",
            unit_of_time="month",
            price_function=self.portfolio.valuation_method,
            token_initial_price=float(initial_nav_per_token),
            name=name,
        )
        self.name = name
        self.cohorts = cohorts or [
            InvestorCohort(
                cohort_id="institutional",
                name="Institutional Income Allocators",
                initial_capital=self.portfolio.initial_aum * 0.50,
                num_holders=4,
                base_subscription_rate_period=0.012,
                distribution_reinvestment_rate=0.30,
                base_redemption_rate_period=0.008,
                target_net_yield_annual=0.064,
                return_shortfall_sensitivity=1.10,
                nav_drawdown_sensitivity=2.00,
                queue_delay_sensitivity=0.45,
            ),
            InvestorCohort(
                cohort_id="hnw",
                name="HNW & Family Offices",
                initial_capital=self.portfolio.initial_aum * 0.30,
                num_holders=20,
                base_subscription_rate_period=0.015,
                distribution_reinvestment_rate=0.25,
                base_redemption_rate_period=0.010,
                target_net_yield_annual=0.064,
                return_shortfall_sensitivity=0.85,
                nav_drawdown_sensitivity=1.50,
                queue_delay_sensitivity=0.35,
            ),
            InvestorCohort(
                cohort_id="retail",
                name="On-Chain Treasury & Retail",
                initial_capital=self.portfolio.initial_aum * 0.20,
                num_holders=200,
                base_subscription_rate_period=0.018,
                distribution_reinvestment_rate=0.15,
                base_redemption_rate_period=0.015,
                target_net_yield_annual=0.060,
                return_shortfall_sensitivity=0.60,
                nav_drawdown_sensitivity=1.15,
                queue_delay_sensitivity=0.25,
            ),
        ]
        self.distribution_policy = distribution_policy
        self.target_distribution_yield_annual = float(target_distribution_yield_annual)
        self.initial_nav_per_token = float(initial_nav_per_token)
        self.secondary_discount_sensitivity = max(0.0, float(secondary_discount_sensitivity))
        self.min_liquidity_buffer_pct_nav = max(0.0, float(min_liquidity_buffer_pct_nav))
        self.reward_token_enabled = bool(reward_token_enabled)
        self.reward_token_annual_budget_fiat = max(0.0, float(reward_token_annual_budget_fiat))
        self.scenario_overrides: Dict[str, Any] = dict(scenario_overrides or {})
        self.random_seed = random_seed
        self._rng = np.random.default_rng(random_seed)

        self.reset()

    def reset(self) -> None:
        self._rng = np.random.default_rng(self.random_seed)
        self.iteration: int = 0
        self.portfolio.reset()
        self.issuer.reset()
        self.facility.reset()
        self.redemption_queue.reset()
        for cohort in self.cohorts:
            cohort.reset(initial_nav_per_token=self.initial_nav_per_token)

        self.active_shares: float = sum(c.active_shares for c in self.cohorts)
        self.supply: float = self.active_shares
        self.nav_total: float = self.portfolio.underlying_asset_value
        self.nav_per_token: float = self.nav_total / max(1e-9, self.active_shares)
        self.price: float = self.nav_per_token
        self.executable_redemption_price: float = self.nav_per_token * (1.0 - self.issuer.redemption_fee_rate)
        self.secondary_market_price: float = self.executable_redemption_price

        self.cumulative_distributions_total_fiat: float = 0.0
        self.cumulative_distributions_cash_fiat: float = 0.0
        self.cumulative_distributions_reinvested_fiat: float = 0.0
        self.cumulative_subscriptions_fiat: float = 0.0
        self.cumulative_token_transfers_shares: float = 0.0

        self._prev_investor_net_profit_fiat: float = 0.0
        self._cumulative_twr_sum: float = 0.0
        self._cumulative_twr_factor: float = 1.0

        self._data_rows: List[Dict[str, Any]] = []
        self._reconciliation_log: List[Dict[str, Any]] = []

    # ------------------------------------------------------------------
    # Core distinct valuation & claim quantities
    # ------------------------------------------------------------------

    @property
    def underlying_asset_value(self) -> float:
        """Quantity 1: Gross underlying asset value (invested + cash + settlement receivables)."""
        return self.portfolio.underlying_asset_value

    @property
    def total_liabilities(self) -> float:
        """Total product-level liabilities (facility principal + unpaid redemption queue obligations)."""
        return self.facility.drawn_balance + self.redemption_queue.unpaid_obligations_fiat

    def compute_current_nav(self) -> Tuple[float, float]:
        """
        Quantity 2: Net Asset Value (total and per active token).

        NAV equals underlying assets minus drawn credit facility principal and
        unpaid redemption obligations.
        """
        nav_tot = max(0.0, self.underlying_asset_value - self.total_liabilities)
        nav_ps = nav_tot / max(1e-9, self.active_shares) if self.active_shares > 1e-9 else 0.0
        return nav_tot, nav_ps

    def compute_executable_prices(self, nav_per_token: float) -> Tuple[float, float]:
        """
        Quantity 4: Executable redemption/sale price per token.

        - `executable_redemption_price`: primary redemption claim net of exit fee.
        - `secondary_market_price`: immediate secondary sale price, which incorporates
          an illiquidity discount when the primary redemption queue is backed up or gated.
        """
        primary_net_price = nav_per_token * (1.0 - self.issuer.redemption_fee_rate)
        nav_tot = max(1.0, self.nav_total)
        queue_ratio = self.redemption_queue.unpaid_obligations_fiat / nav_tot
        secondary_discount = min(
            0.35,
            self.secondary_discount_sensitivity * queue_ratio
            + (0.015 if self.redemption_queue.gate_binding_period else 0.0),
        )
        secondary_price = primary_net_price * (1.0 - secondary_discount)
        return primary_net_price, secondary_price

    def compute_concentration_metrics(self) -> Dict[str, float]:
        """Compute top-holder share and Herfindahl-Hirschman Index (HHI) across investor cohorts."""
        total_sh = max(1e-9, sum(c.active_shares for c in self.cohorts))
        hhi = 0.0
        largest_single_holder_share = 0.0
        for cohort in self.cohorts:
            cohort_share = cohort.active_shares / total_sh
            single_holder_share = cohort_share / float(max(1, cohort.num_holders))
            largest_single_holder_share = max(largest_single_holder_share, single_holder_share)
            hhi += cohort.num_holders * (single_holder_share ** 2)
        return {
            "hhi_index": float(hhi),
            "largest_single_holder_share": float(largest_single_holder_share),
            "largest_cohort_share": float(max((c.active_shares / total_sh) for c in self.cohorts)),
        }

    # ------------------------------------------------------------------
    # Step Execution
    # ------------------------------------------------------------------

    def execute(self) -> Dict[str, Any]:
        """Execute one simulation period (e.g., 1 month) and verify accounting identities."""
        self.iteration += 1
        it = self.iteration
        periods_per_year = self.portfolio.periods_per_year

        # Extract scenario overrides for this step
        ov = self.scenario_overrides
        participation_mult = float(ov.get("participation_multiplier", 1.0))
        redemption_mult = float(ov.get("redemption_multiplier", 1.0))
        yield_delta_annual = float(ov.get("yield_delta_annual", 0.0))
        cap_return_delta_annual = float(ov.get("capital_return_delta_annual", 0.0))
        settlement_lag_override = ov.get("settlement_lag_override", None)
        haircut_bps_override = ov.get("liquidation_haircut_bps_override", None)
        facility_cap_mult = float(ov.get("facility_capacity_multiplier", 1.0))
        spread_shock = float(ov.get("discount_rate_spread_shock", 0.0))

        # Scheduled capital shocks at specific iterations
        scheduled_cap_shocks = ov.get("capital_shock_schedule", {})
        step_cap_shock = float(scheduled_cap_shocks.get(it, scheduled_cap_shocks.get(str(it), 0.0)))

        # Optional stochastic yield/capital noise when running Monte Carlo
        stoch_yield_std = float(ov.get("stochastic_yield_volatility_annual", 0.0))
        stoch_cap_std = float(ov.get("stochastic_capital_volatility_annual", 0.0))
        stoch_redemption_std = float(ov.get("stochastic_redemption_noise_std", 0.0))

        yield_noise = (
            float(self._rng.normal(0.0, stoch_yield_std / math.sqrt(periods_per_year)))
            if stoch_yield_std > 0.0
            else 0.0
        )
        cap_noise = (
            float(self._rng.normal(0.0, stoch_cap_std / math.sqrt(periods_per_year)))
            if stoch_cap_std > 0.0
            else 0.0
        )

        # Record opening cash, NAV, and obligations for strict conservation & fee-basis checks
        opening_cash = self.portfolio.portfolio_cash
        opening_nav_total = self.nav_total
        opening_unpaid_redemptions = self.redemption_queue.unpaid_obligations_fiat
        opening_facility_drawn = self.facility.drawn_balance

        # 1. Mature pending asset sales & reset period flow counters
        matured_receivables_cash = self.portfolio.begin_period(iteration=it)
        self.facility.begin_period(capacity_multiplier=facility_cap_mult)
        self.redemption_queue.begin_period()

        # 2. Accrue portfolio investment income, valuation changes, and portfolio operating expenses
        eff_yield_annual = max(0.0, self.portfolio.gross_yield_annual + yield_delta_annual + yield_noise * periods_per_year)
        eff_cap_annual = self.portfolio.capital_appreciation_annual + cap_return_delta_annual
        queue_ratio_opening = opening_unpaid_redemptions / max(1.0, self.nav_total)

        val_info = self.portfolio.accrue_income_and_valuation(
            iteration=it,
            yield_override_annual=eff_yield_annual,
            capital_return_override_annual=eff_cap_annual,
            valuation_context={
                "stochastic_capital_shock": step_cap_shock + cap_noise,
                "discount_rate_spread_shock": spread_shock,
                "queue_to_nav_ratio": queue_ratio_opening,
            },
        )

        # 3. Accrue credit facility financing costs (interest + commitment fee)
        facility_interest, facility_commitment = self.facility.accrue_financing_costs()
        total_facility_cost = facility_interest + facility_commitment
        portfolio_facility_cost_paid = 0.0
        issuer_facility_cost_paid = 0.0
        if self.facility.cost_bearer == "portfolio":
            portfolio_facility_cost_paid = min(self.portfolio.portfolio_cash, total_facility_cost)
            self.portfolio.portfolio_cash -= portfolio_facility_cost_paid
        else:
            issuer_facility_cost_paid = total_facility_cost

        # 4. Compute pre-fee NAV and charge Management Fee, Admin Fee, and Performance Fee on opening NAV + valuation change
        pre_fee_nav_total, pre_fee_nav_per_token = self.compute_current_nav()
        fee_basis_nav_total = max(0.0, opening_nav_total + self.portfolio.unrealized_valuation_change_period)
        mgmt_fee_due = fee_basis_nav_total * (self.issuer.management_fee_annual / float(periods_per_year))
        admin_fee_due = fee_basis_nav_total * (self.issuer.platform_admin_fee_annual / float(periods_per_year))

        mgmt_fee_paid = min(self.portfolio.portfolio_cash, mgmt_fee_due)
        self.portfolio.portfolio_cash -= mgmt_fee_paid

        portfolio_admin_fee_paid = 0.0
        issuer_admin_fee_paid = 0.0
        if self.issuer.platform_admin_cost_bearer == "portfolio":
            portfolio_admin_fee_paid = min(self.portfolio.portfolio_cash, admin_fee_due)
            self.portfolio.portfolio_cash -= portfolio_admin_fee_paid
        else:
            issuer_admin_fee_paid = admin_fee_due

        # Performance fee on net investment income above hurdle rate
        net_period_income_before_perf = (
            self.portfolio.gross_income_period
            + max(0.0, self.portfolio.unrealized_valuation_change_period)
            - self.portfolio.portfolio_expense_period
            - portfolio_facility_cost_paid
            - mgmt_fee_paid
            - portfolio_admin_fee_paid
        )
        hurdle_amount = fee_basis_nav_total * (self.issuer.hurdle_rate_annual / float(periods_per_year))
        perf_fee_due = 0.0
        if net_period_income_before_perf > hurdle_amount and pre_fee_nav_per_token >= self.issuer.high_water_mark_nav_per_token - 1e-6:
            perf_fee_due = (net_period_income_before_perf - hurdle_amount) * self.issuer.performance_fee_rate
        perf_fee_paid = min(self.portfolio.portfolio_cash, perf_fee_due)
        self.portfolio.portfolio_cash -= perf_fee_paid

        # Update NAV after fees before distributions & capital flows
        nav_after_fees, nav_per_token_after_fees = self.compute_current_nav()
        if nav_per_token_after_fees > self.issuer.high_water_mark_nav_per_token:
            self.issuer.high_water_mark_nav_per_token = nav_per_token_after_fees

        # 5. Investor Distributions (cash vs. reinvested shares)
        distributable_net_income = max(
            0.0,
            self.portfolio.gross_income_period
            - self.portfolio.portfolio_expense_period
            - portfolio_facility_cost_paid
            - mgmt_fee_paid
            - portfolio_admin_fee_paid
            - perf_fee_paid,
        )
        if self.distribution_policy == "full_net_income":
            desired_distribution = distributable_net_income
        elif self.distribution_policy == "target_yield":
            desired_distribution = nav_after_fees * (self.target_distribution_yield_annual / float(periods_per_year))
        elif self.distribution_policy == "accumulating":
            desired_distribution = 0.0
        else:
            desired_distribution = distributable_net_income

        # Cash distributions cannot exceed available portfolio cash
        total_distribution_declared = min(self.portfolio.portfolio_cash, desired_distribution)
        realized_dist_yield_annual = (
            (total_distribution_declared / max(1.0, nav_after_fees)) * float(periods_per_year)
        )

        distributions_cash_paid_period = 0.0
        distributions_reinvested_period = 0.0
        total_active_shares_before_dist = max(1e-9, self.active_shares)

        for cohort in self.cohorts:
            cohort_share = cohort.active_shares / total_active_shares_before_dist
            cohort_dist = total_distribution_declared * cohort_share
            reinvest_fiat = cohort_dist * cohort.distribution_reinvestment_rate
            cash_dist_fiat = cohort_dist - reinvest_fiat

            # Cash leaves portfolio for cash distributions; reinvested distributions stay in cash and mint shares at NAV
            self.portfolio.portfolio_cash -= cash_dist_fiat
            new_reinvest_shares = reinvest_fiat / max(1e-9, nav_per_token_after_fees)
            cohort.active_shares += new_reinvest_shares

            cohort.distributions_cash_period = cash_dist_fiat
            cohort.distributions_reinvested_period = reinvest_fiat
            cohort.cumulative_distributions_cash_fiat += cash_dist_fiat
            cohort.cumulative_distributions_reinvested_fiat += reinvest_fiat

            distributions_cash_paid_period += cash_dist_fiat
            distributions_reinvested_period += reinvest_fiat

        self.active_shares = sum(c.active_shares for c in self.cohorts)
        self.cumulative_distributions_total_fiat += total_distribution_declared
        self.cumulative_distributions_cash_fiat += distributions_cash_paid_period
        self.cumulative_distributions_reinvested_fiat += distributions_reinvested_period

        # Optional traditional tokenomics reward overlay
        reward_yield_boost_annual = 0.0
        reward_fiat_period = 0.0
        if self.reward_token_enabled and self.reward_token_annual_budget_fiat > 0.0:
            reward_fiat_period = self.reward_token_annual_budget_fiat / float(periods_per_year)
            reward_yield_boost_annual = self.reward_token_annual_budget_fiat / max(1.0, nav_after_fees)
            for cohort in self.cohorts:
                cohort.reward_tokens_earned += reward_fiat_period * (cohort.active_shares / max(1e-9, self.active_shares))

        # 6. Investor Subscriptions & Redemption Requests
        nav_before_flows, nav_per_token_flows = self.compute_current_nav()
        total_fund_equity_pool = max(1.0, self.underlying_asset_value - self.facility.drawn_balance)
        queue_ratio_current = self.redemption_queue.unpaid_obligations_fiat / total_fund_equity_pool

        subscriptions_period_fiat = 0.0
        for cohort in self.cohorts:
            sub_fiat = cohort.compute_desired_subscription_fiat(
                current_nav_per_token=nav_per_token_flows,
                realized_net_yield_annual=realized_dist_yield_annual,
                queue_open_ratio=queue_ratio_current,
                participation_multiplier=participation_mult,
            )
            new_shares = sub_fiat / max(1e-9, nav_per_token_flows)
            cohort.active_shares += new_shares
            cohort.subscriptions_fiat_period = sub_fiat
            cohort.cumulative_new_subscriptions_fiat += sub_fiat
            cohort.cumulative_capital_invested += sub_fiat
            self.portfolio.portfolio_cash += sub_fiat
            subscriptions_period_fiat += sub_fiat

        self.active_shares = sum(c.active_shares for c in self.cohorts)
        self.cumulative_subscriptions_fiat += subscriptions_period_fiat

        # Scenario-level concentrated withdrawal shocks
        cohort_shock_map = ov.get("cohort_withdrawal_shocks", {})
        step_cohort_shocks = cohort_shock_map.get(it, cohort_shock_map.get(str(it), {}))
        uniform_shock_map = ov.get("uniform_withdrawal_shocks", {})
        step_uniform_shock = float(uniform_shock_map.get(it, uniform_shock_map.get(str(it), 0.0)))

        exit_fees_to_issuer_period = 0.0
        exit_fees_to_portfolio_period = 0.0

        for cohort in self.cohorts:
            extra_cohort_shock = float(step_cohort_shocks.get(cohort.cohort_id, 0.0)) + step_uniform_shock
            if stoch_redemption_std > 0.0:
                extra_cohort_shock += max(0.0, float(self._rng.normal(0.0, stoch_redemption_std)))

            redeem_frac = cohort.compute_desired_redemption_fraction(
                iteration=it,
                current_nav_per_token=nav_per_token_flows,
                realized_net_yield_annual=realized_dist_yield_annual,
                queue_open_ratio=queue_ratio_current,
                redemption_multiplier=redemption_mult,
                extra_shock_fraction=extra_cohort_shock,
                reward_token_yield_boost_annual=reward_yield_boost_annual,
            )
            shares_to_redeem = min(cohort.active_shares * 0.98, cohort.active_shares * redeem_frac)
            if shares_to_redeem > 1e-9:
                cohort.active_shares -= shares_to_redeem
                cohort.queued_shares_cumulative += shares_to_redeem
                ticket = self.redemption_queue.submit_redemption(
                    cohort_id=cohort.cohort_id,
                    shares_tendered=shares_to_redeem,
                    nav_per_token=nav_per_token_flows,
                    redemption_fee_rate=self.issuer.redemption_fee_rate,
                    iteration=it,
                )
                cohort.redemptions_requested_shares_period = shares_to_redeem
                cohort.redemptions_requested_net_fiat_period = ticket.net_claim_fiat
                cohort.cumulative_redemption_claims_net_fiat += ticket.net_claim_fiat
                cohort.cumulative_exit_fees_borne_fiat += ticket.exit_fee_fiat
                self.cumulative_token_transfers_shares += shares_to_redeem

                # Split exit fee between issuer and portfolio (anti-dilution retention)
                issuer_fee_share = ticket.exit_fee_fiat * self.issuer.redemption_fee_to_issuer_pct
                portfolio_fee_share = ticket.exit_fee_fiat - issuer_fee_share
                exit_fees_to_issuer_period += issuer_fee_share
                exit_fees_to_portfolio_period += portfolio_fee_share
            else:
                cohort.redemptions_requested_shares_period = 0.0
                cohort.redemptions_requested_net_fiat_period = 0.0

        self.active_shares = sum(c.active_shares for c in self.cohorts)

        # Pay the issuer's share of exit fees out of portfolio cash (since the exiting investor's gross NAV
        # remained in the portfolio and only `net_claim_fiat` was booked as a redemption liability)
        issuer_exit_fee_paid = min(self.portfolio.portfolio_cash, exit_fees_to_issuer_period)
        self.portfolio.portfolio_cash -= issuer_exit_fee_paid

        # Track any unpaid period expenses/fees when opening cash was temporarily tight
        unpaid_port_exp = float(val_info.get("unpaid_portfolio_expense", 0.0))
        unpaid_fac_cost = (
            max(0.0, total_facility_cost - portfolio_facility_cost_paid)
            if self.facility.cost_bearer == "portfolio"
            else 0.0
        )
        unpaid_mgmt_fee = max(0.0, mgmt_fee_due - mgmt_fee_paid)
        unpaid_admin_fee = (
            max(0.0, admin_fee_due - portfolio_admin_fee_paid)
            if self.issuer.platform_admin_cost_bearer == "portfolio"
            else 0.0
        )
        unpaid_perf_fee = max(0.0, perf_fee_due - perf_fee_paid)
        unpaid_exit_fee = max(0.0, exit_fees_to_issuer_period - issuer_exit_fee_paid)
        total_unpaid_fees_and_expenses = (
            unpaid_port_exp
            + unpaid_fac_cost
            + unpaid_mgmt_fee
            + unpaid_admin_fee
            + unpaid_perf_fee
            + unpaid_exit_fee
        )

        # 7. Liquidity Management: Asset Sales, Credit Facility Draw/Repay, and Queue Settlement
        # How much cash do we want to have to pay unpaid fees/expenses + redemption queue (subject to gate) + target cash buffer?
        reference_nav_for_gate = max(nav_before_flows, self.underlying_asset_value - self.facility.drawn_balance)
        total_queue_due = self.redemption_queue.unpaid_obligations_fiat
        if self.redemption_queue.gate_max_pct_nav_per_period is not None:
            payable_target_this_period = min(
                total_queue_due,
                reference_nav_for_gate * self.redemption_queue.gate_max_pct_nav_per_period,
            )
        else:
            payable_target_this_period = total_queue_due

        target_cash_buffer = max(0.0, (self.underlying_asset_value - total_queue_due) * self.portfolio.target_cash_buffer_pct)
        cash_shortfall_for_redemptions = max(
            0.0,
            total_unpaid_fees_and_expenses + payable_target_this_period + target_cash_buffer - self.portfolio.portfolio_cash,
        )

        # Account for already pending settlements in transit so we don't over-liquidate the portfolio
        unbacked_shortfall = max(0.0, cash_shortfall_for_redemptions - self.portfolio.pending_settlement_receivables)
        sale_info = self.portfolio.initiate_asset_sale(
            target_net_cash=unbacked_shortfall,
            iteration=it,
            settlement_lag_override=settlement_lag_override,
            haircut_bps_override=haircut_bps_override,
        )

        # If immediate cash is still insufficient to pay unpaid fees/expenses + `payable_target_this_period`, draw on ExternalLiquidityFacility
        immediate_redemption_shortfall = max(
            0.0,
            total_unpaid_fees_and_expenses + payable_target_this_period - self.portfolio.portfolio_cash,
        )
        facility_drawn_now = self.facility.draw(immediate_redemption_shortfall)
        self.portfolio.portfolio_cash += facility_drawn_now

        # Settle any deferred period expenses/fees now that subscription/sale/facility cash is available
        if total_unpaid_fees_and_expenses > 1e-12 and self.portfolio.portfolio_cash > 0.0:
            if unpaid_port_exp > 0.0:
                add_exp = min(self.portfolio.portfolio_cash, unpaid_port_exp)
                self.portfolio.portfolio_cash -= add_exp
                self.portfolio.portfolio_expense_period += add_exp
                self.portfolio.cumulative_portfolio_expense += add_exp
            if unpaid_fac_cost > 0.0:
                add_fac = min(self.portfolio.portfolio_cash, unpaid_fac_cost)
                self.portfolio.portfolio_cash -= add_fac
                portfolio_facility_cost_paid += add_fac
            if unpaid_mgmt_fee > 0.0:
                add_mgmt = min(self.portfolio.portfolio_cash, unpaid_mgmt_fee)
                self.portfolio.portfolio_cash -= add_mgmt
                mgmt_fee_paid += add_mgmt
            if unpaid_admin_fee > 0.0:
                add_adm = min(self.portfolio.portfolio_cash, unpaid_admin_fee)
                self.portfolio.portfolio_cash -= add_adm
                portfolio_admin_fee_paid += add_adm
            if unpaid_perf_fee > 0.0:
                add_perf = min(self.portfolio.portfolio_cash, unpaid_perf_fee)
                self.portfolio.portfolio_cash -= add_perf
                perf_fee_paid += add_perf
            if unpaid_exit_fee > 0.0:
                add_exit = min(self.portfolio.portfolio_cash, unpaid_exit_fee)
                self.portfolio.portfolio_cash -= add_exit
                issuer_exit_fee_paid += add_exit

        # Settle redemption queue in FIFO order using available portfolio cash
        redemptions_paid_fiat, cohort_redemptions_paid = self.redemption_queue.settle_queue(
            available_cash=self.portfolio.portfolio_cash,
            reference_nav_for_gate=reference_nav_for_gate,
            iteration=it,
        )
        self.portfolio.portfolio_cash -= redemptions_paid_fiat

        for cohort in self.cohorts:
            paid_c = cohort_redemptions_paid.get(cohort.cohort_id, 0.0)
            cohort.redemptions_paid_cash_period = paid_c
            cohort.cumulative_redemptions_received_cash_fiat += paid_c

        # If we have excess cash after paying redemptions, repay any drawn facility balance first, then deploy excess above buffer
        if self.facility.drawn_balance > 1e-9 and self.portfolio.portfolio_cash > 0.0:
            repaid_now = self.facility.repay(self.portfolio.portfolio_cash)
            self.portfolio.portfolio_cash -= repaid_now
        else:
            repaid_now = 0.0

        # Deploy surplus cash above target buffer (only when redemption queue is clear)
        if self.redemption_queue.unpaid_obligations_fiat <= 1e-6:
            desired_buffer = max(0.0, self.underlying_asset_value * self.portfolio.target_cash_buffer_pct)
            self.portfolio.deploy_excess_cash(min_cash_to_keep=desired_buffer)

        # 8. Issuer P&L Calculation
        self.issuer.mgmt_fee_period = mgmt_fee_paid
        self.issuer.perf_fee_period = perf_fee_paid
        self.issuer.exit_fee_issuer_period = issuer_exit_fee_paid
        self.issuer.exit_fee_portfolio_period = exit_fees_to_portfolio_period
        self.issuer.admin_fee_period = portfolio_admin_fee_paid + issuer_admin_fee_paid
        self.issuer.fixed_op_cost_period = self.issuer.fixed_operating_cost_annual / float(periods_per_year)
        self.issuer.variable_op_cost_period = (
            fee_basis_nav_total * (self.issuer.variable_operating_cost_bps / 10000.0) / float(periods_per_year)
        )
        self.issuer.facility_cost_issuer_period = issuer_facility_cost_paid + reward_fiat_period

        self.issuer.issuer_revenue_period = mgmt_fee_paid + perf_fee_paid + issuer_exit_fee_paid
        self.issuer.issuer_cost_period = (
            self.issuer.fixed_op_cost_period
            + self.issuer.variable_op_cost_period
            + issuer_admin_fee_paid
            + issuer_facility_cost_paid
            + reward_fiat_period
        )
        self.issuer.issuer_profit_period = self.issuer.issuer_revenue_period - self.issuer.issuer_cost_period

        self.issuer.cumulative_mgmt_fee += mgmt_fee_paid
        self.issuer.cumulative_perf_fee += perf_fee_paid
        self.issuer.cumulative_exit_fee_issuer += issuer_exit_fee_paid
        self.issuer.cumulative_exit_fee_portfolio += exit_fees_to_portfolio_period
        self.issuer.cumulative_admin_fee_portfolio += portfolio_admin_fee_paid
        self.issuer.cumulative_issuer_revenue += self.issuer.issuer_revenue_period
        self.issuer.cumulative_issuer_cost += self.issuer.issuer_cost_period
        self.issuer.cumulative_issuer_profit += self.issuer.issuer_profit_period

        # 9. Final Period Valuation, Prices, Settlement Metrics, and Accounting Reconciliation
        self.nav_total, self.nav_per_token = self.compute_current_nav()
        self.supply = self.active_shares
        self.price = self.nav_per_token
        self.executable_redemption_price, self.secondary_market_price = self.compute_executable_prices(
            self.nav_per_token
        )
        settlement_metrics = self.redemption_queue.compute_settlement_metrics(current_iteration=it)
        concentration_metrics = self.compute_concentration_metrics()

        reconciliation = self.verify_accounting_reconciliation(
            opening_cash=opening_cash,
            opening_unpaid_redemptions=opening_unpaid_redemptions,
            opening_facility_drawn=opening_facility_drawn,
            subscriptions_fiat=subscriptions_period_fiat,
            settled_asset_sales_fiat=self.portfolio.settled_asset_sales_period,
            new_investments_fiat=self.portfolio.new_investments_period,
            facility_drawn_fiat=facility_drawn_now,
            facility_repaid_fiat=repaid_now,
            cash_distributions_paid_fiat=distributions_cash_paid_period,
            redemptions_paid_fiat=redemptions_paid_fiat,
            portfolio_fees_paid_fiat=(
                mgmt_fee_paid + perf_fee_paid + portfolio_admin_fee_paid + issuer_exit_fee_paid
            ),
            portfolio_expenses_paid_fiat=self.portfolio.portfolio_expense_period,
            portfolio_financing_paid_fiat=portfolio_facility_cost_paid,
        )
        self._reconciliation_log.append(reconciliation)

        # Investor cumulative & time-weighted return (TWR) metrics on active capital
        total_initial_capital = sum(c.initial_capital for c in self.cohorts)
        total_capital_contributed = total_initial_capital + self.cumulative_subscriptions_fiat
        investor_ending_economic_value = (
            self.nav_total
            + self.redemption_queue.unpaid_obligations_fiat
            + self.cumulative_distributions_cash_fiat
            + self.redemption_queue.cumulative_payments
        )
        investor_net_profit_fiat = investor_ending_economic_value - total_capital_contributed
        investor_roi_on_total_contributed_pct = (
            investor_net_profit_fiat / max(1.0, total_capital_contributed)
        )

        opening_investor_capital = max(1.0, opening_nav_total + opening_unpaid_redemptions)
        period_net_profit_fiat = investor_net_profit_fiat - self._prev_investor_net_profit_fiat
        self._prev_investor_net_profit_fiat = investor_net_profit_fiat
        period_return_pct = period_net_profit_fiat / opening_investor_capital

        self._cumulative_twr_sum += period_return_pct
        self._cumulative_twr_factor *= max(1e-9, 1.0 + period_return_pct)
        investor_cumulative_return_pct = self._cumulative_twr_sum

        years_elapsed = float(it) / float(periods_per_year)
        if years_elapsed > 0 and self._cumulative_twr_factor > 0:
            investor_annualised_return_pct = (
                self._cumulative_twr_factor ** (1.0 / years_elapsed) - 1.0
            )
        else:
            investor_annualised_return_pct = 0.0

        row = {
            "iteration": it,
            "underlying_asset_value": self.underlying_asset_value,
            "invested_assets": self.portfolio.invested_assets,
            "available_cash": self.portfolio.portfolio_cash,
            "pending_settlement_receivables": self.portfolio.pending_settlement_receivables,
            "nav_total": self.nav_total,
            "nav_per_token": self.nav_per_token,
            "active_shares": self.active_shares,
            "executable_redemption_price": self.executable_redemption_price,
            "secondary_market_price": self.secondary_market_price,
            "gross_income_period": self.portfolio.gross_income_period,
            "portfolio_expense_period": self.portfolio.portfolio_expense_period,
            "unrealized_valuation_change_period": self.portfolio.unrealized_valuation_change_period,
            "realized_liquidation_loss_period": self.portfolio.realized_liquidation_loss_period,
            "cumulative_realized_liquidation_loss": self.portfolio.cumulative_realized_liquidation_loss,
            "distributions_total_period": total_distribution_declared,
            "distributions_cash_period": distributions_cash_paid_period,
            "distributions_reinvested_period": distributions_reinvested_period,
            "cumulative_distributions_total_fiat": self.cumulative_distributions_total_fiat,
            "cumulative_distributions_cash_fiat": self.cumulative_distributions_cash_fiat,
            "investor_net_profit_fiat": investor_net_profit_fiat,
            "investor_period_return_pct": period_return_pct,
            "investor_roi_on_total_contributed_pct": investor_roi_on_total_contributed_pct,
            "investor_cumulative_return_pct": investor_cumulative_return_pct,
            "investor_annualised_return_pct": investor_annualised_return_pct,
            "subscriptions_period_fiat": subscriptions_period_fiat,
            "redemption_requests_gross_period": self.redemption_queue.requests_gross_period,
            "redemption_requests_net_period": self.redemption_queue.requests_net_period,
            "redemption_requests_shares_period": self.redemption_queue.requests_shares_period,
            "redemptions_paid_period": redemptions_paid_fiat,
            "unpaid_redemption_obligations": self.redemption_queue.unpaid_obligations_fiat,
            "gate_binding_period": self.redemption_queue.gate_binding_period,
            "max_time_to_payment_periods": settlement_metrics["max_time_to_payment_periods"],
            "weighted_avg_time_to_payment_periods": settlement_metrics["weighted_avg_time_to_payment_periods"],
            "open_queue_max_age_periods": settlement_metrics["open_queue_max_age_periods"],
            "sla_met": settlement_metrics["sla_met"],
            "facility_max_capacity": self.facility.max_capacity,
            "facility_drawn_balance": self.facility.drawn_balance,
            "facility_available_capacity": self.facility.available_capacity,
            "facility_financing_cost_period": total_facility_cost,
            "cumulative_facility_financing_cost": self.facility.cumulative_financing_cost,
            "issuer_mgmt_fee_period": mgmt_fee_paid,
            "issuer_perf_fee_period": perf_fee_paid,
            "issuer_exit_fee_period": issuer_exit_fee_paid,
            "portfolio_retained_exit_fee_period": exit_fees_to_portfolio_period,
            "issuer_revenue_period": self.issuer.issuer_revenue_period,
            "issuer_cost_period": self.issuer.issuer_cost_period,
            "issuer_profit_period": self.issuer.issuer_profit_period,
            "cumulative_issuer_revenue": self.issuer.cumulative_issuer_revenue,
            "cumulative_issuer_cost": self.issuer.cumulative_issuer_cost,
            "cumulative_issuer_profit": self.issuer.cumulative_issuer_profit,
            "cash_plus_facility_to_nav_ratio": (
                (self.portfolio.portfolio_cash + self.facility.available_capacity) / max(1.0, self.nav_total)
            ),
            "hhi_concentration": concentration_metrics["hhi_index"],
            "largest_single_holder_share": concentration_metrics["largest_single_holder_share"],
            "reconciled": reconciliation["all_reconciled"],
        }
        self._data_rows.append(row)
        return row

    def run_Fixed_iterations(self, num_iterations: int = 36) -> pd.DataFrame:
        """Run the tokenised product economy for `num_iterations` periods."""
        for _ in range(int(num_iterations)):
            self.execute()
        return self.get_data()

    def get_data(self) -> pd.DataFrame:
        """Return time-series dataframe of all simulation steps."""
        return pd.DataFrame(self._data_rows)

    # ------------------------------------------------------------------
    # Section 7 Financial Logic Verification & Solvency Locks
    # ------------------------------------------------------------------

    def verify_accounting_reconciliation(
        self,
        opening_cash: float,
        opening_unpaid_redemptions: float,
        opening_facility_drawn: float,
        subscriptions_fiat: float,
        settled_asset_sales_fiat: float,
        new_investments_fiat: float,
        facility_drawn_fiat: float,
        facility_repaid_fiat: float,
        cash_distributions_paid_fiat: float,
        redemptions_paid_fiat: float,
        portfolio_fees_paid_fiat: float,
        portfolio_expenses_paid_fiat: float,
        portfolio_financing_paid_fiat: float,
        tol: float = 1e-4,
    ) -> Dict[str, Any]:
        """
        Verify exact financial accounting conservation at the current iteration:
        1. Balance sheet reconciliation: Gross Assets - Liabilities == Active NAV.
        2. Cash flow conservation: Opening Cash + Inflows - Outflows == Ending Cash.
        3. Redemption queue conservation: Opening Queue + New Net Claims - Paid == Ending Queue.
        4. Credit facility conservation: Opening Drawn + Drawn - Repaid == Ending Drawn.
        5. Non-negativity: Cash, Invested Assets, Facility Available, and Shares >= 0.
        """
        # 1. Balance sheet check
        gross_assets = self.underlying_asset_value
        liabilities = self.total_liabilities
        balance_sheet_diff = abs((gross_assets - liabilities) - self.nav_total)
        balance_sheet_ok = balance_sheet_diff <= tol

        # 2. Cash flow check
        expected_ending_cash = (
            opening_cash
            + subscriptions_fiat
            + self.portfolio.gross_income_period
            + settled_asset_sales_fiat
            + facility_drawn_fiat
            - new_investments_fiat
            - cash_distributions_paid_fiat
            - redemptions_paid_fiat
            - portfolio_fees_paid_fiat
            - portfolio_expenses_paid_fiat
            - portfolio_financing_paid_fiat
            - facility_repaid_fiat
        )
        cash_diff = abs(expected_ending_cash - self.portfolio.portfolio_cash)
        cash_ok = cash_diff <= tol

        # 3. Redemption queue liability check
        expected_ending_queue = (
            opening_unpaid_redemptions
            + self.redemption_queue.requests_net_period
            - redemptions_paid_fiat
        )
        queue_diff = abs(expected_ending_queue - self.redemption_queue.unpaid_obligations_fiat)
        queue_ok = queue_diff <= tol

        # 4. Facility principal check
        expected_facility_drawn = opening_facility_drawn + facility_drawn_fiat - facility_repaid_fiat
        facility_diff = abs(expected_facility_drawn - self.facility.drawn_balance)
        facility_ok = facility_diff <= tol

        # 5. Non-negativity check
        non_negative_ok = (
            self.portfolio.portfolio_cash >= -tol
            and self.portfolio.invested_assets >= -tol
            and self.facility.drawn_balance >= -tol
            and self.facility.available_capacity >= -tol
            and self.active_shares >= -tol
        )

        all_ok = bool(balance_sheet_ok and cash_ok and queue_ok and facility_ok and non_negative_ok)
        if not all_ok:
            raise AssertionError(
                f"Financial reconciliation failed at step {self.iteration}: "
                f"bs_diff={balance_sheet_diff:.6f}, cash_diff={cash_diff:.6f}, "
                f"queue_diff={queue_diff:.6f}, fac_diff={facility_diff:.6f}, non_neg={non_negative_ok}"
            )

        return {
            "iteration": self.iteration,
            "all_reconciled": all_ok,
            "balance_sheet_diff": float(balance_sheet_diff),
            "cash_flow_diff": float(cash_diff),
            "redemption_queue_diff": float(queue_diff),
            "facility_balance_diff": float(facility_diff),
            "non_negative_ok": bool(non_negative_ok),
        }

    # ------------------------------------------------------------------
    # AuditableConfig & Tokenomist Review Rule Implementation
    # ------------------------------------------------------------------

    def get_supply_parameters(self) -> Dict[str, Any]:
        return {
            "audience_reserve_initial": self.portfolio.portfolio_cash,
            "treasury_initial": self.portfolio.invested_assets,
            "total_supply": self.portfolio.initial_aum,
        }

    def get_cohort_parameters(self) -> Dict[str, Dict[str, Any]]:
        total_init = max(1.0, sum(c.initial_capital for c in self.cohorts))
        return {
            c.cohort_id: {
                "name": c.name,
                "population_share": c.initial_capital / total_init,
                "utility_spend_rate": c.base_subscription_rate_period,
                "settle_propensity": c.base_redemption_rate_period,
                "distribution_reinvestment_rate": c.distribution_reinvestment_rate,
            }
            for c in self.cohorts
        }

    def get_registered_locks(self) -> List[Dict[str, Any]]:
        """
        Implement HARD and SOFT parameter/solvency locks per `.agent/rules/tokenomist_review_rules.md`.
        """
        def _lock_accounting() -> Tuple[bool, str]:
            if not self._reconciliation_log:
                return True, "No steps executed yet"
            all_ok = all(r["all_reconciled"] for r in self._reconciliation_log)
            return all_ok, f"Checked {len(self._reconciliation_log)} steps for exact balance-sheet/cash conservation"

        def _lock_net_yield_positive() -> Tuple[bool, str]:
            net_yield = (
                self.portfolio.gross_yield_annual
                - self.portfolio.portfolio_expense_annual
                - self.issuer.management_fee_annual
            )
            return net_yield > 0.0, f"Expected net portfolio yield before perf fee = {net_yield * 100:.2f}% p.a."

        def _lock_payment_sla() -> Tuple[bool, str]:
            metrics = self.redemption_queue.compute_settlement_metrics(current_iteration=self.iteration)
            return (
                bool(metrics["sla_met"]),
                f"Max time to full payment = {metrics['max_time_to_payment_periods']:.1f} periods "
                f"(SLA <= {self.redemption_queue.payment_sla_periods} periods)",
            )

        def _lock_issuer_breakeven() -> Tuple[bool, str]:
            be = self.issuer.compute_breakeven_aum(
                expected_gross_portfolio_return_annual=self.portfolio.gross_yield_annual,
                portfolio_expense_annual=self.portfolio.portfolio_expense_annual,
                facility_max_capacity=self.facility.base_max_capacity,
                facility_commitment_fee_annual=self.facility.commitment_fee_annual,
                facility_cost_bearer=self.facility.cost_bearer,
            )
            passed = self.issuer.cumulative_issuer_profit >= 0.0
            return (
                passed,
                f"Cumulative issuer profit = ${self.issuer.cumulative_issuer_profit:,.0f} "
                f"(Analytical break-even AUM = ${be['breakeven_aum']:,.0f})",
            )

        return [
            {
                "id": "L1_ACCOUNTING_CONSERVATION",
                "type": "HARD",
                "description": "Cash, assets, claims, and obligations reconcile at every step without negative balances",
                "check_fn": _lock_accounting,
            },
            {
                "id": "L2_POSITIVE_NET_PORTFOLIO_CARRY",
                "type": "HARD",
                "description": "Gross asset yield exceeds recurring management and portfolio operating expenses",
                "check_fn": _lock_net_yield_positive,
            },
            {
                "id": "L3_REDEMPTION_PAYMENT_SLA",
                "type": "SOFT",
                "description": "All redemption requests settle within the stated payment deadline SLA",
                "check_fn": _lock_payment_sla,
            },
            {
                "id": "L4_ISSUER_OPERATING_PROFITABILITY",
                "type": "SOFT",
                "description": "Cumulative issuer fee revenue covers cumulative operating and issuer-borne financing costs",
                "check_fn": _lock_issuer_breakeven,
            },
        ]

    def check_solvency_locks(self) -> Dict[str, Any]:
        """Execute all registered HARD and SOFT locks and return a structured report."""
        results = []
        hard_passed = True
        for lock in self.get_registered_locks():
            ok, msg = lock["check_fn"]()
            if not ok and lock["type"] == "HARD":
                hard_passed = False
            results.append(
                {
                    "id": lock["id"],
                    "type": lock["type"],
                    "description": lock["description"],
                    "passed": bool(ok),
                    "detail": msg,
                }
            )
        return {"all_hard_locks_passed": hard_passed, "locks": results}

    def summarize_outcomes(self) -> Dict[str, Any]:
        """Produce a comprehensive summary of all Section 5 outputs for reporting and comparison."""
        df = self.get_data()
        periods_per_year = self.portfolio.periods_per_year
        n_periods = len(df)
        years = max(1.0 / periods_per_year, float(n_periods) / float(periods_per_year))

        settlement = self.redemption_queue.compute_settlement_metrics(current_iteration=self.iteration)
        breakeven = self.issuer.compute_breakeven_aum(
            expected_gross_portfolio_return_annual=self.portfolio.gross_yield_annual,
            portfolio_expense_annual=self.portfolio.portfolio_expense_annual,
            facility_max_capacity=self.facility.base_max_capacity,
            facility_commitment_fee_annual=self.facility.commitment_fee_annual,
            facility_cost_bearer=self.facility.cost_bearer,
        )
        locks = self.check_solvency_locks()

        last = df.iloc[-1].to_dict() if not df.empty else {}
        min_nav_per_token = float(df["nav_per_token"].min()) if not df.empty else 1.0
        min_secondary_price = float(df["secondary_market_price"].min()) if not df.empty else 1.0
        min_cash_buffer_ratio = float(df["cash_plus_facility_to_nav_ratio"].min()) if not df.empty else 0.0
        peak_unpaid_queue = float(df["unpaid_redemption_obligations"].max()) if not df.empty else 0.0
        peak_facility_drawn = float(df["facility_drawn_balance"].max()) if not df.empty else 0.0

        cohort_summaries = []
        for c in self.cohorts:
            ending_active_val = c.active_shares * self.nav_per_token
            unpaid_claim = sum(
                t.remaining_fiat for t in self.redemption_queue.tickets if t.cohort_id == c.cohort_id and not t.is_settled
            )
            total_econ_val = (
                ending_active_val
                + unpaid_claim
                + c.cumulative_distributions_cash_fiat
                + c.cumulative_redemptions_received_cash_fiat
            )
            net_gain = total_econ_val - c.cumulative_capital_invested
            avg_cohort_cap = max(1.0, 0.5 * (c.initial_capital + ending_active_val + unpaid_claim))
            tot_ret = net_gain / avg_cohort_cap
            ann_ret = ((1.0 + tot_ret) ** (1.0 / years) - 1.0) if (1.0 + tot_ret) > 0 else -1.0
            cohort_summaries.append(
                {
                    "cohort_id": c.cohort_id,
                    "name": c.name,
                    "initial_capital": c.initial_capital,
                    "cumulative_capital_invested": c.cumulative_capital_invested,
                    "ending_active_shares": c.active_shares,
                    "ending_active_nav_fiat": ending_active_val,
                    "distributions_cash_received_fiat": c.cumulative_distributions_cash_fiat,
                    "distributions_reinvested_fiat": c.cumulative_distributions_reinvested_fiat,
                    "redemptions_requested_net_fiat": c.cumulative_redemption_claims_net_fiat,
                    "redemptions_paid_cash_fiat": c.cumulative_redemptions_received_cash_fiat,
                    "unpaid_redemption_claim_fiat": unpaid_claim,
                    "exit_fees_borne_fiat": c.cumulative_exit_fees_borne_fiat,
                    "reward_tokens_earned_fiat": c.reward_tokens_earned,
                    "net_economic_profit_fiat": net_gain,
                    "cumulative_net_return_pct": tot_ret,
                    "annualised_net_return_pct": ann_ret,
                }
            )

        out_dict: Dict[str, Any] = {
            "product_name": self.name,
            "periods": n_periods,
            "periods_per_year": periods_per_year,
            "years_simulated": years,
            # Investor outcomes
            "investor_distributions_total_fiat": self.cumulative_distributions_total_fiat,
            "investor_distributions_cash_fiat": self.cumulative_distributions_cash_fiat,
            "investor_distributions_reinvested_fiat": self.cumulative_distributions_reinvested_fiat,
            "investor_distributions_reward_token_fiat": float(sum(c.reward_tokens_earned for c in self.cohorts)),
            "investor_net_profit_fiat": float(last.get("investor_net_profit_fiat", 0.0)),
            "investor_roi_on_total_contributed_pct": float(last.get("investor_roi_on_total_contributed_pct", 0.0)),
            "investor_cumulative_return_pct": float(last.get("investor_cumulative_return_pct", 0.0)),
            "investor_annualised_return_pct": float(last.get("investor_annualised_return_pct", 0.0)),
            # Asset & NAV vs executable price
            "initial_aum": self.portfolio.initial_aum,
            "ending_underlying_asset_value": self.underlying_asset_value,
            "ending_invested_assets": self.portfolio.invested_assets,
            "ending_available_cash": self.portfolio.portfolio_cash,
            "ending_pending_settlement_receivables": self.portfolio.pending_settlement_receivables,
            "ending_nav_total": self.nav_total,
            "ending_nav_per_token": self.nav_per_token,
            "min_nav_per_token": min_nav_per_token,
            "ending_executable_redemption_price": self.executable_redemption_price,
            "ending_secondary_market_price": self.secondary_market_price,
            "min_secondary_market_price": min_secondary_price,
            "cumulative_unrealized_valuation_change": self.portfolio.cumulative_unrealized_valuation_change,
            "cumulative_realized_liquidation_loss": self.portfolio.cumulative_realized_liquidation_loss,
            # Issuer economics & break-even scale
            "issuer_cumulative_revenue_fiat": self.issuer.cumulative_issuer_revenue,
            "issuer_cumulative_mgmt_fee_fiat": self.issuer.cumulative_mgmt_fee,
            "issuer_cumulative_perf_fee_fiat": self.issuer.cumulative_perf_fee,
            "issuer_cumulative_exit_fee_fiat": self.issuer.cumulative_exit_fee_issuer,
            "portfolio_retained_exit_fee_fiat": self.issuer.cumulative_exit_fee_portfolio,
            "issuer_cumulative_cost_fiat": self.issuer.cumulative_issuer_cost,
            "issuer_cumulative_profit_fiat": self.issuer.cumulative_issuer_profit,
            "issuer_annualised_profit_fiat": self.issuer.cumulative_issuer_profit / years,
            "issuer_profitable": self.issuer.cumulative_issuer_profit >= 0.0,
            "breakeven_aum_fiat": breakeven["breakeven_aum"],
            "breakeven_details": breakeven,
            "cost_attribution_schedule": self.issuer.get_cost_attribution_schedule(self.facility.cost_bearer),
            # Liquidity, queue, and financing costs
            "cumulative_subscriptions_fiat": self.cumulative_subscriptions_fiat,
            "cumulative_redemption_requests_gross_fiat": self.redemption_queue.cumulative_requests_gross,
            "cumulative_redemption_requests_net_fiat": self.redemption_queue.cumulative_requests_net,
            "cumulative_redemptions_paid_fiat": self.redemption_queue.cumulative_payments,
            "ending_unpaid_redemption_obligations_fiat": self.redemption_queue.unpaid_obligations_fiat,
            "peak_unpaid_redemption_obligations_fiat": peak_unpaid_queue,
            "max_time_to_payment_periods": settlement["max_time_to_payment_periods"],
            "weighted_avg_time_to_payment_periods": settlement["weighted_avg_time_to_payment_periods"],
            "open_queue_max_age_periods": settlement["open_queue_max_age_periods"],
            "payment_sla_periods": self.redemption_queue.payment_sla_periods,
            "payment_sla_met": settlement["sla_met"],
            "facility_max_capacity_fiat": self.facility.max_capacity,
            "ending_facility_drawn_fiat": self.facility.drawn_balance,
            "ending_facility_available_fiat": self.facility.available_capacity,
            "Ending_facility_available_fiat": self.facility.available_capacity,
            "peak_facility_drawn_fiat": peak_facility_drawn,
            "cumulative_facility_financing_cost_fiat": self.facility.cumulative_financing_cost,
            "total_liquidity_and_financing_costs_fiat": (
                self.facility.cumulative_financing_cost + self.portfolio.cumulative_realized_liquidation_loss
            ),
            "min_cash_plus_facility_to_nav_ratio": min_cash_buffer_ratio,
            "liquidity_buffer_floor_met": min_cash_buffer_ratio >= self.min_liquidity_buffer_pct_nav,
            # Verification & cohorts
            "all_steps_reconciled": all(r["all_reconciled"] for r in self._reconciliation_log),
            "solvency_locks": locks,
            "cohorts": cohort_summaries,
        }
        reward_yield_annual = (
            (self.reward_token_annual_budget_fiat / max(1.0, self.portfolio.initial_aum))
            if self.reward_token_enabled
            else 0.0
        )
        scorecard = compute_product_scorecard(
            outcomes=out_dict,
            gross_yield_annual=self.portfolio.gross_yield_annual,
            reward_yield_annual=reward_yield_annual,
        )
        out_dict["scorecard"] = scorecard
        out_dict["yield_efficiency_score"] = scorecard["yield_efficiency_score"]
        out_dict["liquidity_sla_score"] = scorecard["liquidity_sla_score"]
        out_dict["price_stability_score"] = scorecard["price_stability_score"]
        out_dict["issuer_viability_score"] = scorecard["issuer_viability_score"]
        out_dict["stress_resilience_score"] = scorecard["stress_resilience_score"]
        out_dict["composite_score_100"] = scorecard["composite_score_100"]
        out_dict["rating_grade"] = scorecard["rating_grade"]
        return out_dict


def compute_product_scorecard(
    outcomes: Dict[str, Any],
    gross_yield_annual: float = 0.085,
    reward_yield_annual: float = 0.0,
) -> Dict[str, Any]:
    """
    Compute the 5-Pillar Quantitative Product Scorecard (0–100 scale) and
    Institutional Rating Grade (`AAA`, `AA`, `A`, `BBB`, `BB`, `B`).

    Pillars & Weights:
    1. `yield_efficiency_score` (25%): Combines absolute annualised net investor
       return (including any contractual token reward drip, relative to a 9.0% p.a.
       institutional ceiling) and net-to-gross yield retention efficiency.
    2. `liquidity_sla_score` (25%): Penalises maximum and weighted-average redemption
       payment wait times, SLA breaches (>3 months), and peak unpaid queue ratios.
    3. `price_stability_score` (20%): Penalises accounting NAV drawdowns, secondary
       market illiquidity price discounts, and realised forced-liquidation losses.
    4. `issuer_viability_score` (15%): Combines analytical break-even AUM
       accessibility (relative to $110M scale) and annualised issuer operating margin.
    5. `stress_resilience_score` (15%): Evaluates minimum cash + available credit
       facility coverage (relative to 20% full coverage and the 3% solvency floor)
       and terminal redemption queue clearance.
    """
    def _num(val: Any, default: float = 0.0) -> float:
        if val is None:
            return default
        try:
            fval = float(val)
        except (TypeError, ValueError):
            return default
        return default if math.isnan(fval) else fval

    def _clip(val: Any, lo: float = 0.0, hi: float = 100.0) -> float:
        fval = _num(val, lo)
        return max(lo, min(hi, fval))

    r_net = _num(outcomes.get("investor_annualised_return_pct", 0.0), 0.0)
    init_aum = max(1.0, _num(outcomes.get("initial_aum", 25_000_000.0), 25_000_000.0))

    # Pillar 1: Net Yield & Fee Efficiency (25%)
    s_abs = _clip(((r_net + _num(reward_yield_annual, 0.0)) / 0.090) * 100.0)
    retention_ratio = max(0.0, r_net) / max(0.01, _num(gross_yield_annual, 0.085))
    s_ret = _clip((retention_ratio / 0.90) * 100.0)
    p1_yield = round(0.60 * s_abs + 0.40 * s_ret, 1)

    # Pillar 2: Liquidity & Redemption SLA (25%)
    w_max = _num(outcomes.get("max_time_to_payment_periods", 0.0), 0.0)
    w_avg = _num(outcomes.get("weighted_avg_time_to_payment_periods", 0.0), 0.0)
    q_peak_ratio = _num(outcomes.get("peak_unpaid_redemption_obligations_fiat", 0.0), 0.0) / init_aum
    sla_penalty = 0.0 if bool(outcomes.get("payment_sla_met", True)) else 15.0
    p2_liquidity = round(
        _clip(100.0 - 12.0 * w_max - 8.0 * w_avg - 100.0 * q_peak_ratio - sla_penalty),
        1,
    )

    # Pillar 3: NAV & Secondary Price Stability (20%)
    min_nav = _num(outcomes.get("min_nav_per_token", 1.0), 1.0)
    min_sec = _num(outcomes.get("min_secondary_market_price", 1.0), 1.0)
    d_nav = max(0.0, 1.0 - min_nav)
    d_sec = max(0.0, 1.0 - min_sec)
    l_liq_ratio = _num(outcomes.get("cumulative_realized_liquidation_loss", 0.0), 0.0) / init_aum
    p3_stability = round(
        _clip(100.0 - 450.0 * d_nav - 250.0 * d_sec - 800.0 * l_liq_ratio),
        1,
    )

    # Pillar 4: Issuer Economic Viability & Scale Efficiency (15%)
    raw_be = outcomes.get("breakeven_aum_fiat", 50_000_000.0)
    be_aum = float("inf") if raw_be is None else _num(raw_be, float("inf"))
    s_be = _clip(100.0 * (1.0 - be_aum / 110_000_000.0))
    ann_profit = _num(outcomes.get("issuer_annualised_profit_fiat", 0.0), 0.0)
    m_prof = ann_profit / 210_000.0
    s_prof = _clip(50.0 + 35.0 * m_prof)
    p4_issuer = round(0.50 * s_be + 0.50 * s_prof, 1)

    # Pillar 5: Tail-Risk & Liquidity Buffer Resilience (15%)
    b_min = _num(outcomes.get("min_cash_plus_facility_to_nav_ratio", 0.0), 0.0)
    s_buf = _clip((b_min / 0.20) * 65.0, 0.0, 65.0)
    s_floor = 20.0 if bool(outcomes.get("liquidity_buffer_floor_met", False)) else 0.0
    end_q_ratio = _num(outcomes.get("ending_unpaid_redemption_obligations_fiat", 0.0), 0.0) / init_aum
    s_clear = (
        _clip(15.0 * (1.0 - end_q_ratio * 10.0), 0.0, 15.0)
        if min_nav > 0.05
        else 0.0
    )
    p5_stress = round(_clip(s_buf + s_floor + s_clear), 1)

    composite = round(
        0.25 * p1_yield
        + 0.25 * p2_liquidity
        + 0.20 * p3_stability
        + 0.15 * p4_issuer
        + 0.15 * p5_stress,
        1,
    )
    if composite >= 85.0:
        grade = "AAA"
    elif composite >= 78.0:
        grade = "AA"
    elif composite >= 70.0:
        grade = "A"
    elif composite >= 62.0:
        grade = "BBB"
    elif composite >= 52.0:
        grade = "BB"
    else:
        grade = "B"

    return {
        "yield_efficiency_score": p1_yield,
        "liquidity_sla_score": p2_liquidity,
        "price_stability_score": p3_stability,
        "issuer_viability_score": p4_issuer,
        "stress_resilience_score": p5_stress,
        "composite_score_100": composite,
        "rating_grade": grade,
        "weights": {
            "yield_efficiency": 0.25,
            "liquidity_sla": 0.25,
            "price_stability": 0.20,
            "issuer_viability": 0.15,
            "stress_resilience": 0.15,
        },
    }

