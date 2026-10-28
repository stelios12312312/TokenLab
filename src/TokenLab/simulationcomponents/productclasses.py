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
        settle_expense: bool = True,
    ) -> Dict[str, float]:
        """
        Accrue cash investment income, valuation changes, and portfolio operating expenses.

        With `settle_expense=False` the expense is only computed (`portfolio_expense_due`)
        and the caller pays or accrues it.
        """
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
        if settle_expense:
            paid_exp = min(self.portfolio_cash, portfolio_exp)
            self.portfolio_cash -= paid_exp
            self.portfolio_expense_period = paid_exp
            self.cumulative_portfolio_expense += paid_exp
        else:
            paid_exp = 0.0
            self.portfolio_expense_period = portfolio_exp
            self.cumulative_portfolio_expense += portfolio_exp

        return {
            "gross_income": gross_income,
            "unrealized_valuation_change": val_change,
            "portfolio_expense": paid_exp,
            "portfolio_expense_due": portfolio_exp,
            "unpaid_portfolio_expense": max(0.0, portfolio_exp - paid_exp) if settle_expense else 0.0,
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
        self.writedown_period: float = 0.0
        self.cumulative_writedown: float = 0.0

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
        self.writedown_period = 0.0

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

    def write_down(self, amount: float) -> float:
        """Write down drawn principal the fund cannot repay (lender loss on insolvency)."""
        cut = min(max(0.0, amount), self.drawn_balance)
        self.drawn_balance -= cut
        self.writedown_period += cut
        self.cumulative_writedown += cut
        return cut


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
        income_share_fee_rate: float = 0.0,
    ) -> None:
        super().__init__()
        if platform_admin_cost_bearer not in ("portfolio", "issuer"):
            raise ValueError("platform_admin_cost_bearer must be 'portfolio' or 'issuer'.")
        self.management_fee_annual = max(0.0, float(management_fee_annual))
        # Fee charged as a share of gross portfolio income (e.g. a lending platform's cut of interest)
        self.income_share_fee_rate = max(0.0, min(1.0, float(income_share_fee_rate)))
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
        # High-water mark on the per-unit total-return index (NAV plus distributions), so paying
        # out income does not reset it
        self.high_water_mark_total_return: float = 1.0
        self.mgmt_fee_period: float = 0.0
        self.perf_fee_period: float = 0.0
        self.exit_fee_issuer_period: float = 0.0
        self.exit_fee_portfolio_period: float = 0.0
        self.admin_fee_period: float = 0.0
        self.fixed_op_cost_period: float = 0.0
        self.variable_op_cost_period: float = 0.0
        self.facility_cost_issuer_period: float = 0.0
        self.reward_cost_period: float = 0.0

        self.issuer_revenue_period: float = 0.0
        self.issuer_cost_period: float = 0.0
        self.issuer_profit_period: float = 0.0

        self.cumulative_mgmt_fee: float = 0.0
        self.cumulative_perf_fee: float = 0.0
        self.cumulative_exit_fee_issuer: float = 0.0
        self.cumulative_exit_fee_portfolio: float = 0.0
        self.cumulative_admin_fee_portfolio: float = 0.0
        self.cumulative_reward_cost: float = 0.0
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
                "rate_description": (
                    f"{self.management_fee_annual * 100:.2f}% p.a. of NAV"
                    + (
                        f" + {self.income_share_fee_rate * 100:.1f}% of gross portfolio income"
                        if self.income_share_fee_rate > 0.0
                        else ""
                    )
                ),
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
        invested_fraction: float = 1.0,
        reward_budget_annual_fiat: float = 0.0,
    ) -> Dict[str, Any]:
        """
        Calculate analytical break-even AUM ($A_{\\text{BE}}$) required for the
        issuer's recurring net fee contribution margin to cover fixed costs.

        Income accrues only on the invested share of AUM (`invested_fraction`; the
        cash buffer earns nothing). Revenue = NAV fee + income-share fee + expected
        performance fee + issuer share of exit fees on `expected_annual_redemption_turnover`.
        Token reward budgets are a fixed annual cost. Returns `breakeven_aum=None`
        when the contribution margin is not positive.
        """
        gross_income_rate = expected_gross_portfolio_return_annual * max(0.0, min(1.0, invested_fraction))
        income_fee_rate = gross_income_rate * self.income_share_fee_rate
        net_pre_perf_return = (
            gross_income_rate
            - portfolio_expense_annual
            - self.management_fee_annual
            - income_fee_rate
            - (self.platform_admin_fee_annual if self.platform_admin_cost_bearer == "portfolio" else 0.0)
        )
        expected_perf_fee_rate_of_aum = (
            max(0.0, net_pre_perf_return - self.hurdle_rate_annual) * self.performance_fee_rate
        )
        expected_exit_fee_rate_of_aum = (
            expected_annual_redemption_turnover * self.redemption_fee_rate * self.redemption_fee_to_issuer_pct
        )
        gross_revenue_margin_rate = (
            self.management_fee_annual + income_fee_rate + expected_perf_fee_rate_of_aum + expected_exit_fee_rate_of_aum
        )

        issuer_var_cost_rate = (self.variable_operating_cost_bps / 10000.0) + (
            self.platform_admin_fee_annual if self.platform_admin_cost_bearer == "issuer" else 0.0
        )
        net_contribution_margin_rate = gross_revenue_margin_rate - issuer_var_cost_rate

        fixed_cost_total = (
            self.fixed_operating_cost_annual
            + max(0.0, reward_budget_annual_fiat)
            + (facility_max_capacity * facility_commitment_fee_annual if facility_cost_bearer == "issuer" else 0.0)
        )

        achievable = net_contribution_margin_rate > 1e-9
        return {
            "breakeven_aum": float(fixed_cost_total / net_contribution_margin_rate) if achievable else None,
            "is_achievable": achievable,
            "gross_revenue_margin_bps": gross_revenue_margin_rate * 10000.0,
            "income_share_fee_bps": income_fee_rate * 10000.0,
            "issuer_variable_cost_bps": issuer_var_cost_rate * 10000.0,
            "net_contribution_margin_bps": net_contribution_margin_rate * 10000.0,
            "fixed_annual_costs_fiat": fixed_cost_total,
            "reward_budget_annual_fiat": max(0.0, reward_budget_annual_fiat),
        }


# ---------------------------------------------------------------------------
# 5. FIFO Redemption Queue & Settlement Obligation Tracker
# ---------------------------------------------------------------------------

QUEUE_PRICING_MODES: Tuple[str, ...] = ("payment_date_nav", "request_date_nav")


@dataclass
class RedemptionTicket:
    """
    A single investor redemption request in the settlement queue.

    Under `payment_date_nav` pricing the tendered shares stay in the fund until
    paid: they keep earning, share any gains or losses, and are redeemed at the
    NAV prevailing on each payment date. Under `request_date_nav` pricing the
    shares are converted at request into a fixed net cash claim (`net_claim_fiat`).
    """

    ticket_id: int
    cohort_id: str
    request_iteration: int
    pricing_mode: str
    shares_tendered: float
    shares_remaining: float
    nav_per_token_at_request: float
    gross_claim_fiat: float
    exit_fee_fiat: float
    net_claim_fiat: float
    paid_fiat: float = 0.0
    written_down_fiat: float = 0.0
    settled_iteration: Optional[int] = None
    payments: List[Tuple[int, float]] = field(default_factory=list)

    @property
    def remaining_fixed_claim_fiat(self) -> float:
        """Unpaid fixed claim (request-date pricing only)."""
        if self.pricing_mode != "request_date_nav":
            return 0.0
        return max(0.0, self.net_claim_fiat - self.paid_fiat - self.written_down_fiat)

    def remaining_value_fiat(self, net_price_per_share: float) -> float:
        """Unpaid net value: the fixed claim, or escrowed shares at the current net redemption price."""
        if self.pricing_mode == "request_date_nav":
            return self.remaining_fixed_claim_fiat
        return max(0.0, self.shares_remaining) * max(0.0, net_price_per_share)

    @property
    def is_settled(self) -> bool:
        if self.pricing_mode == "request_date_nav":
            return self.remaining_fixed_claim_fiat <= 1e-7
        return self.shares_remaining <= 1e-9


class RedemptionQueueManager(Controller):
    """
    Manages redemption requests, redemption gates, FIFO cash settlement, and
    time-to-payment metrics under either queue pricing mode.
    """

    def __init__(
        self,
        gate_max_pct_nav_per_period: Optional[float] = None,
        payment_sla_periods: int = 3,
        pricing_mode: str = "payment_date_nav",
    ) -> None:
        super().__init__()
        if pricing_mode not in QUEUE_PRICING_MODES:
            raise ValueError(f"RedemptionQueueManager pricing_mode must be one of {QUEUE_PRICING_MODES}.")
        self.gate_max_pct_nav_per_period = (
            None if gate_max_pct_nav_per_period is None else max(0.0, float(gate_max_pct_nav_per_period))
        )
        self.payment_sla_periods = max(0, int(payment_sla_periods))
        self.pricing_mode = pricing_mode
        self.reset()

    def reset(self) -> None:
        self._next_ticket_id: int = 1
        self.tickets: List[RedemptionTicket] = []
        self.requests_gross_period: float = 0.0
        self.requests_net_period: float = 0.0
        self.requests_shares_period: float = 0.0
        self.exit_fees_period: float = 0.0
        self.payments_period: float = 0.0
        self.shares_redeemed_period: float = 0.0
        self.writedowns_period: float = 0.0
        self.gate_cap_fiat_period: float = float("inf")
        self.gate_binding_period: bool = False

        self.cumulative_requests_gross: float = 0.0
        self.cumulative_requests_net: float = 0.0
        self.cumulative_payments: float = 0.0
        self.cumulative_exit_fees: float = 0.0
        self.cumulative_writedowns: float = 0.0

    def begin_period(self) -> None:
        self.requests_gross_period = 0.0
        self.requests_net_period = 0.0
        self.requests_shares_period = 0.0
        self.exit_fees_period = 0.0
        self.payments_period = 0.0
        self.shares_redeemed_period = 0.0
        self.writedowns_period = 0.0
        self.gate_cap_fiat_period = float("inf")
        self.gate_binding_period = False

    @property
    def escrowed_shares(self) -> float:
        """Shares tendered under payment-date pricing that are still waiting to be redeemed."""
        return float(sum(t.shares_remaining for t in self.tickets if t.pricing_mode == "payment_date_nav" and not t.is_settled))

    @property
    def fixed_claims_fiat(self) -> float:
        """Unpaid fixed cash claims (request-date pricing), a liability of the fund."""
        return float(sum(t.remaining_fixed_claim_fiat for t in self.tickets if not t.is_settled))

    def unpaid_value_fiat(self, net_price_per_share: float) -> float:
        """Net value still owed to the queue at `net_price_per_share` for escrowed shares."""
        return float(sum(t.remaining_value_fiat(net_price_per_share) for t in self.tickets if not t.is_settled))

    @property
    def unpaid_tickets_count(self) -> int:
        return sum(1 for t in self.tickets if not t.is_settled)

    def escrowed_shares_by_cohort(self) -> Dict[str, float]:
        out: Dict[str, float] = {}
        for t in self.tickets:
            if t.pricing_mode == "payment_date_nav" and not t.is_settled:
                out[t.cohort_id] = out.get(t.cohort_id, 0.0) + t.shares_remaining
        return out

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

        Under request-date pricing the tender becomes a fixed net claim and the exit
        fee is charged now. Under payment-date pricing the shares are escrowed; the
        gross, fee and net amounts recorded here are indicative, and the fee is
        charged on each payment. No cash moves until `settle_queue`.
        """
        fee_rate = max(0.0, min(0.5, redemption_fee_rate))
        gross_claim = max(0.0, shares_tendered * nav_per_token)
        exit_fee = gross_claim * fee_rate
        net_claim = gross_claim - exit_fee
        is_fixed = self.pricing_mode == "request_date_nav"

        ticket = RedemptionTicket(
            ticket_id=self._next_ticket_id,
            cohort_id=cohort_id,
            request_iteration=iteration,
            pricing_mode=self.pricing_mode,
            shares_tendered=shares_tendered,
            shares_remaining=0.0 if is_fixed else shares_tendered,
            nav_per_token_at_request=nav_per_token,
            gross_claim_fiat=gross_claim,
            exit_fee_fiat=exit_fee if is_fixed else 0.0,
            net_claim_fiat=net_claim,
        )
        self._next_ticket_id += 1
        self.tickets.append(ticket)

        self.requests_gross_period += gross_claim
        self.requests_net_period += net_claim
        self.requests_shares_period += shares_tendered
        self.cumulative_requests_gross += gross_claim
        self.cumulative_requests_net += net_claim
        if is_fixed:
            self.exit_fees_period += exit_fee
            self.cumulative_exit_fees += exit_fee
        return ticket

    def settle_queue(
        self,
        available_cash: float,
        gate_cap_fiat: float,
        nav_per_token: float,
        redemption_fee_rate: float,
        iteration: int,
    ) -> Dict[str, Any]:
        """
        Pay open redemption tickets in strict FIFO order, respecting `available_cash`
        and the product-level redemption gate (`gate_cap_fiat` for this period).

        Escrowed shares are redeemed at `nav_per_token` net of the exit fee; the fee
        on each payment is returned in `exit_fees` for the caller to split.
        """
        fee_rate = max(0.0, min(0.5, redemption_fee_rate))
        net_price = max(0.0, nav_per_token) * (1.0 - fee_rate)
        out: Dict[str, Any] = {
            "paid": 0.0,
            "cohort_paid": {},
            "cohort_exit_fees": {},
            "shares_redeemed": 0.0,
            "exit_fees": 0.0,
        }
        total_due = self.unpaid_value_fiat(net_price)
        if self.unpaid_tickets_count == 0:
            return out

        if self.gate_max_pct_nav_per_period is not None:
            self.gate_cap_fiat_period = max(0.0, gate_cap_fiat)
            if total_due > self.gate_cap_fiat_period + 1e-6:
                self.gate_binding_period = True
            budget = min(max(0.0, available_cash), self.gate_cap_fiat_period)
        else:
            budget = max(0.0, available_cash)

        for ticket in self.tickets:
            if ticket.is_settled:
                continue
            if ticket.pricing_mode == "payment_date_nav" and net_price <= 1e-12:
                # Shares of a fund with no remaining value are cancelled without payment
                out["shares_redeemed"] += ticket.shares_remaining
                ticket.shares_remaining = 0.0
                ticket.settled_iteration = iteration
                continue
            if budget <= 1e-9:
                break
            if ticket.pricing_mode == "request_date_nav":
                pay = min(ticket.remaining_fixed_claim_fiat, budget)
            else:
                needed = ticket.shares_remaining * net_price
                pay = min(needed, budget)
                shares = ticket.shares_remaining if pay >= needed - 1e-9 else pay / net_price
                fee = shares * nav_per_token * fee_rate
                ticket.shares_remaining -= shares
                ticket.exit_fee_fiat += fee
                out["shares_redeemed"] += shares
                out["exit_fees"] += fee
                out["cohort_exit_fees"][ticket.cohort_id] = out["cohort_exit_fees"].get(ticket.cohort_id, 0.0) + fee
            ticket.paid_fiat += pay
            ticket.payments.append((iteration, pay))
            budget -= pay
            out["paid"] += pay
            out["cohort_paid"][ticket.cohort_id] = out["cohort_paid"].get(ticket.cohort_id, 0.0) + pay
            if ticket.is_settled:
                ticket.settled_iteration = iteration

        self.payments_period += out["paid"]
        self.cumulative_payments += out["paid"]
        self.shares_redeemed_period += out["shares_redeemed"]
        self.exit_fees_period += out["exit_fees"]
        self.cumulative_exit_fees += out["exit_fees"]
        return out

    def write_down_fixed_claims(self, amount: float) -> float:
        """Reduce unpaid fixed claims pro rata by up to `amount` (insolvency loss allocation)."""
        owed = self.fixed_claims_fiat
        cut = min(max(0.0, amount), owed)
        if cut <= 1e-12:
            return 0.0
        scale = cut / owed
        for ticket in self.tickets:
            remaining = ticket.remaining_fixed_claim_fiat
            if remaining > 0.0:
                ticket.written_down_fiat += remaining * scale
        self.writedowns_period += cut
        self.cumulative_writedowns += cut
        return cut

    def compute_settlement_metrics(self, current_iteration: int, net_price_per_share: float = 1.0) -> Dict[str, Any]:
        """
        Compute time-to-payment, open backlog age, and SLA compliance metrics.

        - `max_time_to_payment_periods`: longest wait from request to full settlement.
        - `weighted_avg_time_to_payment_periods`: dollar-weighted wait in which each
          payment carries its own wait from request.
        Tickets still open at `current_iteration` count their elapsed wait as a lower
        bound; their value is reported as `open_queue_censored_fiat`.
        """
        if not self.tickets:
            return {
                "max_time_to_payment_periods": 0.0,
                "weighted_avg_time_to_payment_periods": 0.0,
                "open_queue_max_age_periods": 0.0,
                "open_queue_censored_fiat": 0.0,
                "sla_breach_count": 0,
                "sla_met": True,
            }

        full_waits: List[float] = []
        chunk_waits: List[float] = []
        chunk_amounts: List[float] = []
        open_ages: List[float] = []
        open_value = 0.0
        sla_breaches = 0

        for ticket in self.tickets:
            if ticket.shares_tendered <= 1e-12 and ticket.net_claim_fiat <= 1e-9:
                continue
            for paid_iteration, amount in ticket.payments:
                chunk_waits.append(float(paid_iteration - ticket.request_iteration))
                chunk_amounts.append(amount)
            if ticket.is_settled and ticket.settled_iteration is not None:
                wait = float(ticket.settled_iteration - ticket.request_iteration)
            else:
                # Still unpaid at `current_iteration` (at least one period of unresolved wait)
                wait = float((current_iteration - ticket.request_iteration) + 1)
                open_ages.append(wait)
                remaining = ticket.remaining_value_fiat(net_price_per_share)
                if remaining > 0.0:
                    chunk_waits.append(wait)
                    chunk_amounts.append(remaining)
                    open_value += remaining
            full_waits.append(wait)
            if wait > float(self.payment_sla_periods):
                sla_breaches += 1

        total_amount = sum(chunk_amounts)
        w_avg = float(np.average(chunk_waits, weights=chunk_amounts)) if total_amount > 0 else 0.0
        return {
            "max_time_to_payment_periods": max(full_waits) if full_waits else 0.0,
            "weighted_avg_time_to_payment_periods": w_avg,
            "open_queue_max_age_periods": max(open_ages) if open_ages else 0.0,
            "open_queue_censored_fiat": float(open_value),
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
        nav_drawdown: float,
        realized_net_yield_annual: float,
        queue_open_ratio: float,
        participation_multiplier: float = 1.0,
    ) -> float:
        """Compute new cash subscriptions from this cohort for the period."""
        current_holding_value = self.active_shares * current_nav_per_token
        # Inflows slow down if there is an unpaid redemption queue or a drawdown from the running peak
        confidence_factor = max(0.0, 1.0 - 2.0 * queue_open_ratio - max(0.0, nav_drawdown) * 3.0)
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
        nav_drawdown: float,
        realized_net_yield_annual: float,
        queue_open_ratio: float,
        redemption_multiplier: float = 1.0,
        extra_shock_fraction: float = 0.0,
        reward_token_yield_boost_annual: float = 0.0,
        periods_per_year: int = 12,
    ) -> float:
        """
        Compute the fraction of `active_shares` this cohort wishes to redeem in `iteration`.

        Combines:
        1. Baseline liquidity turnover (`base_redemption_rate_period * redemption_multiplier`)
        2. Yield shortfall response (`return_shortfall_sensitivity * max(0, target - effective_yield)`)
        3. Drawdown response (`nav_drawdown_sensitivity * drawdown from the running peak`)
        4. Queue run contagion (`queue_delay_sensitivity * queue_open_ratio`)
        5. Explicit scenario/cohort withdrawal shocks (`shock_redemption_schedule[iteration] + extra_shock_fraction`)

        The endogenous part (1-4) is capped at 65% per period; scheduled shocks add on
        top, so a 100% scheduled shock redeems the whole cohort.
        """
        ppy = float(max(1, int(periods_per_year)))
        effective_yield = realized_net_yield_annual + reward_token_yield_boost_annual
        yield_shortfall = max(0.0, self.target_net_yield_annual - effective_yield)

        endogenous_rate = (
            self.base_redemption_rate_period * max(0.0, redemption_multiplier)
            + (self.return_shortfall_sensitivity * yield_shortfall / ppy)
            + (self.nav_drawdown_sensitivity * max(0.0, nav_drawdown) / ppy)
            + (self.queue_delay_sensitivity * min(1.0, queue_open_ratio) / ppy)
        )
        scheduled_shock = float(self.shock_redemption_schedule.get(iteration, 0.0)) + float(extra_shock_fraction)
        return max(0.0, min(1.0, min(0.65, endogenous_rate) + scheduled_shock))


# ---------------------------------------------------------------------------
# 7. TokenisedProductEconomy (Main Reusable Product Engine)
# ---------------------------------------------------------------------------

PAYABLE_CATEGORIES: Tuple[str, ...] = (
    "portfolio_expense",
    "facility_cost",
    "management_fee",
    "admin_fee",
    "performance_fee",
    "issuer_exit_fee",
)


class TokenisedProductEconomy(TokenEconomy, AuditableConfig):
    """
    Complete, reusable economic model for a tokenised investment product or RWA fund.

    Preserves compatibility with TokenLab's `TokenEconomy` and `AuditableConfig`
    interfaces while modeling asset cash flows, NAV vs. executable price, issuer
    P&L, multi-cohort investor behaviour, redemption queues, settlement delays,
    and external liquidity facilities.

    Accounting is on an accrual basis: fees and expenses that cannot be paid from
    cash are carried as payables (a liability in NAV) and settled first when cash
    arrives. When liabilities exceed assets, claims are written down instead of
    letting NAV go negative.
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
        secondary_required_return_annual: float = 0.12,
        secondary_illiquidity_premium: float = 0.01,
        secondary_max_discount: float = 0.35,
        min_liquidity_buffer_pct_nav: float = 0.03,
        reward_token_enabled: bool = False,
        reward_token_annual_budget_fiat: float = 0.0,
        expected_annual_redemption_turnover: float = 0.12,
        risk_free_rate_annual: float = 0.0,
        reference_real_aum_fiat: Optional[float] = None,
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
        self.secondary_required_return_annual = max(0.0, float(secondary_required_return_annual))
        self.secondary_illiquidity_premium = max(0.0, float(secondary_illiquidity_premium))
        self.secondary_max_discount = max(0.0, min(0.95, float(secondary_max_discount)))
        self.min_liquidity_buffer_pct_nav = max(0.0, float(min_liquidity_buffer_pct_nav))
        self.reward_token_enabled = bool(reward_token_enabled)
        self.reward_token_annual_budget_fiat = max(0.0, float(reward_token_annual_budget_fiat))
        self.expected_annual_redemption_turnover = max(0.0, float(expected_annual_redemption_turnover))
        self.risk_free_rate_annual = float(risk_free_rate_annual)
        self.reference_real_aum_fiat = None if reference_real_aum_fiat is None else max(0.0, float(reference_real_aum_fiat))
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

        self.payables: Dict[str, float] = {category: 0.0 for category in PAYABLE_CATEGORIES}
        self.cumulative_payables_writedown: float = 0.0
        self._payables_accrued_period: float = 0.0
        self._payables_paid_period: float = 0.0
        self._payables_writedown_period: float = 0.0
        self._cash_paid_obligations_period: float = 0.0
        self._writedowns_period: float = 0.0

        self.active_shares: float = sum(c.active_shares for c in self.cohorts)
        self.nav_per_token: float = self.initial_nav_per_token
        self.nav_total, self.nav_per_token = self.compute_current_nav()
        self.supply: float = self.share_base
        self.price: float = self.nav_per_token
        self.executable_redemption_price: float = self.nav_per_token * (1.0 - self.issuer.redemption_fee_rate)
        self.secondary_market_price: float = self.executable_redemption_price
        self.expected_wait: float = 0.0

        self.cumulative_distributions_total_fiat: float = 0.0
        self.cumulative_distributions_cash_fiat: float = 0.0
        self.cumulative_distributions_reinvested_fiat: float = 0.0
        self.cumulative_subscriptions_fiat: float = 0.0
        self.cumulative_token_transfers_shares: float = 0.0

        self.total_return_index: float = 1.0
        self._total_return_peak: float = 1.0
        self.max_total_return_drawdown: float = 0.0
        self._holding_yield_annual: float = 0.0
        self._last_subscriptions_fiat: float = 0.0
        self._prev_investor_net_profit_fiat: float = 0.0
        self._base_return_factor: float = 1.0
        self._investor_cash_flows: List[float] = []

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
    def total_payables(self) -> float:
        """Accrued fees and expenses not yet paid in cash."""
        return float(sum(self.payables.values()))

    @property
    def total_liabilities(self) -> float:
        """Facility principal, fixed redemption claims (request-date pricing) and payables."""
        return self.facility.drawn_balance + self.redemption_queue.fixed_claims_fiat + self.total_payables

    @property
    def share_base(self) -> float:
        """Shares with a claim on NAV: active shares plus shares escrowed in the queue."""
        return self.active_shares + self.redemption_queue.escrowed_shares

    def investor_equity(self) -> float:
        """Capital belonging to all investors, queued redemptions included: assets less facility and payables."""
        return self.underlying_asset_value - self.facility.drawn_balance - self.total_payables

    def compute_current_nav(self) -> Tuple[float, float]:
        """
        Quantity 2: Net Asset Value (total and per share).

        NAV equals underlying assets minus drawn facility principal, fixed redemption
        claims and payables. Per-share NAV divides by the share base (active plus
        escrowed shares); with no shares outstanding the last NAV per share is kept.
        """
        nav_tot = self.underlying_asset_value - self.total_liabilities
        base = self.share_base
        nav_ps = nav_tot / base if base > 1e-9 else self.nav_per_token
        return nav_tot, nav_ps

    def queue_value_fiat(self, nav_per_token: Optional[float] = None) -> float:
        """Net value owed to the redemption queue (escrowed shares at the current net redemption price)."""
        nps = self.nav_per_token if nav_per_token is None else nav_per_token
        return self.redemption_queue.unpaid_value_fiat(max(0.0, nps) * (1.0 - self.issuer.redemption_fee_rate))

    def queue_ratio(self, nav_per_token: Optional[float] = None) -> float:
        """Unpaid redemption value as a share of investor equity (queued capital included)."""
        return self.queue_value_fiat(nav_per_token) / max(1.0, self.investor_equity())

    def _effective_settlement_lag(self) -> int:
        override = self.scenario_overrides.get("settlement_lag_override")
        return self.portfolio.settlement_lag_periods if override is None else max(0, int(override))

    def _effective_haircut_rate(self) -> float:
        override = self.scenario_overrides.get("liquidation_haircut_bps_override")
        bps = self.portfolio.liquidation_haircut_bps if override is None else max(0.0, float(override))
        return min(0.95, bps / 10000.0)

    def _receivables_due_by(self, iteration: int) -> float:
        return float(
            sum(item.net_cash_proceeds for item in self.portfolio.pending_settlements if item.maturity_iteration <= iteration)
        )

    def liquidity_coverage_ratio(self) -> float:
        """
        Same-period liquid resources relative to investor equity: cash, undrawn facility,
        receivables settling next period, and invested assets that settle within the
        period (zero settlement lag) net of the liquidation haircut.
        """
        haircut = self._effective_haircut_rate()
        same_period_assets = self.portfolio.invested_assets * (1.0 - haircut) if self._effective_settlement_lag() == 0 else 0.0
        resources = (
            self.portfolio.portfolio_cash
            + self.facility.available_capacity
            + self._receivables_due_by(self.iteration + 1)
            + same_period_assets
        )
        return resources / max(1.0, self.investor_equity())

    def expected_wait_periods(self) -> float:
        """
        Periods needed to clear the current redemption queue: queue value divided by the
        liquidity that can reach investors each period (cash, undrawn facility,
        receivables settling next period, new subscriptions at the latest rate, and
        invested assets sold over the settlement lag), capped by the gate. A queue that
        those near-term sources cannot cover waits at least one settlement lag.
        """
        queue_value = self.queue_value_fiat()
        if queue_value <= 1e-6:
            return 0.0
        lag = self._effective_settlement_lag()
        haircut = self._effective_haircut_rate()
        net_invested = self.portfolio.invested_assets * (1.0 - haircut)
        available_now = (
            self.portfolio.portfolio_cash
            + self.facility.available_capacity
            + self._receivables_due_by(self.iteration + 1)
            + self._last_subscriptions_fiat
            + (net_invested if lag == 0 else 0.0)
        )
        throughput = available_now + (net_invested / lag if lag > 0 else 0.0)
        gate = self.redemption_queue.gate_max_pct_nav_per_period
        if gate is not None:
            throughput = min(throughput, gate * max(0.0, self.investor_equity()))
        wait = queue_value / max(1e-9, throughput)
        if lag > 0 and queue_value > available_now + 1e-6:
            wait = max(wait, float(lag))
        return float(wait)

    def compute_executable_prices(self, nav_per_token: float) -> Tuple[float, float]:
        """
        Quantity 4: Executable redemption/sale price per token.

        - `executable_redemption_price`: primary redemption claim net of exit fee.
        - `secondary_market_price`: immediate sale price. A buyer of a token while the
          queue is backed up waits `expected_wait_periods()` to redeem, so the discount
          is the carry the buyer forgoes over that wait (required return less the yield
          the position keeps earning) plus a declared illiquidity premium that phases
          in with the wait. The discount is zero with no queue and continuous in it.
        """
        primary_net_price = nav_per_token * (1.0 - self.issuer.redemption_fee_rate)
        self.expected_wait = self.expected_wait_periods()
        if self.expected_wait <= 0.0:
            return primary_net_price, primary_net_price
        ppy = float(self.portfolio.periods_per_year)
        holding_yield = self._holding_yield_annual if self.redemption_queue.pricing_mode == "payment_date_nav" else 0.0
        carry = 1.0 - math.exp(-max(0.0, self.secondary_required_return_annual - holding_yield) * self.expected_wait / ppy)
        premium = self.secondary_illiquidity_premium * (1.0 - math.exp(-self.expected_wait))
        secondary_discount = min(self.secondary_max_discount, carry + premium)
        return primary_net_price, primary_net_price * (1.0 - secondary_discount)

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
    # Accrual helpers
    # ------------------------------------------------------------------

    def _pay_or_accrue(self, category: str, due: float) -> float:
        """Pay `due` from portfolio cash; any unpaid remainder is carried as a payable."""
        due = max(0.0, float(due))
        paid = min(max(0.0, self.portfolio.portfolio_cash), due)
        self.portfolio.portfolio_cash -= paid
        unpaid = due - paid
        if unpaid > 0.0:
            self.payables[category] += unpaid
            self._payables_accrued_period += unpaid
        self._cash_paid_obligations_period += paid
        return paid

    def _settle_payables(self) -> float:
        """Pay carried payables from portfolio cash in `PAYABLE_CATEGORIES` order."""
        paid_total = 0.0
        for category in PAYABLE_CATEGORIES:
            owed = self.payables[category]
            if owed <= 1e-12:
                continue
            pay = min(max(0.0, self.portfolio.portfolio_cash), owed)
            if pay <= 0.0:
                break
            self.portfolio.portfolio_cash -= pay
            self.payables[category] -= pay
            paid_total += pay
        self._payables_paid_period += paid_total
        self._cash_paid_obligations_period += paid_total
        return paid_total

    def _resolve_insolvency(self) -> float:
        """
        When liabilities exceed assets, write claims down instead of letting NAV go
        negative: fixed redemption claims first, then payables pro rata, then facility
        principal.
        """
        shortfall = self.total_liabilities - self.underlying_asset_value
        if shortfall <= 1e-9:
            return 0.0
        written = self.redemption_queue.write_down_fixed_claims(shortfall)
        shortfall -= written
        owed = self.total_payables
        if shortfall > 1e-9 and owed > 1e-12:
            cut = min(shortfall, owed)
            scale = cut / owed
            for category in PAYABLE_CATEGORIES:
                self.payables[category] -= self.payables[category] * scale
            self._payables_writedown_period += cut
            self.cumulative_payables_writedown += cut
            written += cut
            shortfall -= cut
        if shortfall > 1e-9:
            written += self.facility.write_down(shortfall)
        self._writedowns_period += written
        return written

    def _drawdown_if(self, nav_per_token: float, distribution_per_share: float, opening_nav_per_token: float) -> float:
        """Drawdown of the per-unit total-return index from its peak if NAV per share moved to `nav_per_token`."""
        if opening_nav_per_token <= 1e-12:
            return 0.0
        tr_now = self.total_return_index * (nav_per_token + distribution_per_share) / opening_nav_per_token
        return max(0.0, 1.0 - tr_now / max(self._total_return_peak, tr_now, 1e-12))

    # ------------------------------------------------------------------
    # Step Execution
    # ------------------------------------------------------------------

    def execute(self) -> Dict[str, Any]:
        """Execute one simulation period (e.g., 1 month) and verify accounting identities."""
        self.iteration += 1
        it = self.iteration
        periods_per_year = self.portfolio.periods_per_year
        payment_pricing = self.redemption_queue.pricing_mode == "payment_date_nav"

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
        shock_multiplier = max(0.0, float(ov.get("withdrawal_shock_multiplier", 1.0)))

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

        # Record opening state for conservation checks and fee bases
        opening_cash = self.portfolio.portfolio_cash
        opening_nav_total = self.nav_total
        opening_nav_per_token = self.nav_per_token
        opening_investor_equity = self.investor_equity()
        opening_fixed_claims = self.redemption_queue.fixed_claims_fiat
        opening_share_base = self.share_base
        opening_facility_drawn = self.facility.drawn_balance
        opening_payables = self.total_payables
        self._payables_accrued_period = 0.0
        self._payables_paid_period = 0.0
        self._payables_writedown_period = 0.0
        self._cash_paid_obligations_period = 0.0
        self._writedowns_period = 0.0

        # 1. Mature pending asset sales & reset period flow counters
        self.portfolio.begin_period(iteration=it)
        self.facility.begin_period(capacity_multiplier=facility_cap_mult)
        self.redemption_queue.begin_period()

        # 2. Accrue investment income and valuation changes; settle carried payables, then this period's expenses
        eff_yield_annual = max(0.0, self.portfolio.gross_yield_annual + yield_delta_annual + yield_noise * periods_per_year)
        eff_cap_annual = self.portfolio.capital_appreciation_annual + cap_return_delta_annual
        val_info = self.portfolio.accrue_income_and_valuation(
            iteration=it,
            yield_override_annual=eff_yield_annual,
            capital_return_override_annual=eff_cap_annual,
            valuation_context={
                "stochastic_capital_shock": step_cap_shock + cap_noise,
                "discount_rate_spread_shock": spread_shock,
                "queue_to_nav_ratio": self.queue_ratio(),
            },
            settle_expense=False,
        )
        gross_income = self.portfolio.gross_income_period
        val_change = self.portfolio.unrealized_valuation_change_period
        self._settle_payables()
        expense_due = float(val_info["portfolio_expense_due"])
        self._pay_or_accrue("portfolio_expense", expense_due)
        self._resolve_insolvency()

        # 3. Accrue credit facility financing costs (interest + commitment fee)
        facility_interest, facility_commitment = self.facility.accrue_financing_costs()
        total_facility_cost = facility_interest + facility_commitment
        portfolio_facility_cost_due = total_facility_cost if self.facility.cost_bearer == "portfolio" else 0.0
        issuer_facility_cost_paid = total_facility_cost - portfolio_facility_cost_due
        self._pay_or_accrue("facility_cost", portfolio_facility_cost_due)

        # 4. Accrue management (NAV- and income-based), admin and performance fees on opening NAV + valuation change
        pre_fee_nav_total, pre_fee_nav_per_token = self.compute_current_nav()
        fee_basis_nav_total = max(0.0, opening_nav_total + val_change)
        mgmt_fee_due = (
            fee_basis_nav_total * (self.issuer.management_fee_annual / float(periods_per_year))
            + gross_income * self.issuer.income_share_fee_rate
        )
        admin_fee_due = fee_basis_nav_total * (self.issuer.platform_admin_fee_annual / float(periods_per_year))
        portfolio_admin_fee_due = admin_fee_due if self.issuer.platform_admin_cost_bearer == "portfolio" else 0.0
        issuer_admin_fee_paid = admin_fee_due - portfolio_admin_fee_due
        self._pay_or_accrue("management_fee", mgmt_fee_due)
        self._pay_or_accrue("admin_fee", portfolio_admin_fee_due)

        # Performance fee on net income above the hurdle, charged only while the per-unit
        # total-return index (NAV plus distributions) is at or above its high-water mark
        net_period_income_before_perf = (
            gross_income
            + max(0.0, val_change)
            - expense_due
            - portfolio_facility_cost_due
            - mgmt_fee_due
            - portfolio_admin_fee_due
        )
        hurdle_amount = fee_basis_nav_total * (self.issuer.hurdle_rate_annual / float(periods_per_year))
        pre_fee_total_return = (
            self.total_return_index * pre_fee_nav_per_token / opening_nav_per_token if opening_nav_per_token > 1e-12 else 0.0
        )
        perf_fee_due = 0.0
        if (
            net_period_income_before_perf > hurdle_amount
            and pre_fee_total_return >= self.issuer.high_water_mark_total_return - 1e-9
        ):
            perf_fee_due = (net_period_income_before_perf - hurdle_amount) * self.issuer.performance_fee_rate
        self._pay_or_accrue("performance_fee", perf_fee_due)
        self._resolve_insolvency()

        # Update NAV and the high-water mark after fees, before distributions & capital flows
        nav_after_fees, nav_per_token_after_fees = self.compute_current_nav()
        if opening_nav_per_token > 1e-12:
            self.issuer.high_water_mark_total_return = max(
                self.issuer.high_water_mark_total_return,
                self.total_return_index * nav_per_token_after_fees / opening_nav_per_token,
            )
        net_income_after_fees = (
            gross_income - expense_due - portfolio_facility_cost_due - mgmt_fee_due - portfolio_admin_fee_due - perf_fee_due
        )
        self._holding_yield_annual = max(0.0, net_income_after_fees / max(1.0, nav_after_fees) * float(periods_per_year))

        # 5. Investor Distributions (cash vs. reinvested shares), declared per share on the whole share base
        distributable_net_income = max(0.0, net_income_after_fees)
        if self.distribution_policy == "full_net_income":
            desired_distribution = distributable_net_income
        elif self.distribution_policy == "target_yield":
            desired_distribution = max(0.0, nav_after_fees) * (self.target_distribution_yield_annual / float(periods_per_year))
        elif self.distribution_policy == "accumulating":
            desired_distribution = 0.0
        else:
            desired_distribution = distributable_net_income

        # Cash distributions cannot exceed available portfolio cash
        total_distribution_declared = min(max(0.0, self.portfolio.portfolio_cash), desired_distribution)
        share_base_before_dist = max(1e-9, self.share_base)
        distribution_per_share = total_distribution_declared / share_base_before_dist
        ex_distribution_price = max(1e-9, nav_per_token_after_fees - distribution_per_share)
        realized_dist_yield_annual = (total_distribution_declared / max(1.0, nav_after_fees)) * float(periods_per_year)

        distributions_cash_paid_period = 0.0
        distributions_reinvested_period = 0.0
        reinvested_shares_minted = 0.0
        escrowed_by_cohort = self.redemption_queue.escrowed_shares_by_cohort()
        for cohort in self.cohorts:
            cohort_dist = distribution_per_share * cohort.active_shares
            reinvest_fiat = cohort_dist * cohort.distribution_reinvestment_rate
            # Shares waiting in the redemption queue receive their distribution in cash
            cash_dist_fiat = (cohort_dist - reinvest_fiat) + distribution_per_share * escrowed_by_cohort.get(cohort.cohort_id, 0.0)

            # Cash leaves the portfolio; reinvested distributions stay in cash and mint shares at the ex-distribution NAV
            self.portfolio.portfolio_cash -= cash_dist_fiat
            new_reinvest_shares = reinvest_fiat / ex_distribution_price
            cohort.active_shares += new_reinvest_shares
            reinvested_shares_minted += new_reinvest_shares

            cohort.distributions_cash_period = cash_dist_fiat
            cohort.distributions_reinvested_period = reinvest_fiat
            cohort.cumulative_distributions_cash_fiat += cash_dist_fiat
            cohort.cumulative_distributions_reinvested_fiat += reinvest_fiat

            distributions_cash_paid_period += cash_dist_fiat
            distributions_reinvested_period += reinvest_fiat

        self.active_shares = sum(c.active_shares for c in self.cohorts)
        self.cumulative_distributions_total_fiat += distributions_cash_paid_period + distributions_reinvested_period
        self.cumulative_distributions_cash_fiat += distributions_cash_paid_period
        self.cumulative_distributions_reinvested_fiat += distributions_reinvested_period

        # Optional traditional tokenomics reward overlay (funded by the issuer, valued in fiat)
        reward_yield_boost_annual = 0.0
        reward_fiat_period = 0.0
        if self.reward_token_enabled and self.reward_token_annual_budget_fiat > 0.0:
            reward_fiat_period = self.reward_token_annual_budget_fiat / float(periods_per_year)
            reward_yield_boost_annual = self.reward_token_annual_budget_fiat / max(1.0, nav_after_fees)
            for cohort in self.cohorts:
                cohort.reward_tokens_earned += reward_fiat_period * (cohort.active_shares / max(1e-9, self.active_shares))

        # 6. Investor Subscriptions & Redemption Requests
        nav_before_flows, nav_per_token_flows = self.compute_current_nav()
        queue_ratio_current = self.queue_ratio(nav_per_token_flows)
        drawdown_now = self._drawdown_if(nav_per_token_flows, distribution_per_share, opening_nav_per_token)

        subscriptions_period_fiat = 0.0
        subscription_shares_minted = 0.0
        for cohort in self.cohorts:
            sub_fiat = 0.0
            if nav_per_token_flows > 1e-9:
                sub_fiat = cohort.compute_desired_subscription_fiat(
                    current_nav_per_token=nav_per_token_flows,
                    nav_drawdown=drawdown_now,
                    realized_net_yield_annual=realized_dist_yield_annual,
                    queue_open_ratio=queue_ratio_current,
                    participation_multiplier=participation_mult,
                )
            new_shares = sub_fiat / max(1e-9, nav_per_token_flows)
            cohort.active_shares += new_shares
            subscription_shares_minted += new_shares
            cohort.subscriptions_fiat_period = sub_fiat
            cohort.cumulative_new_subscriptions_fiat += sub_fiat
            cohort.cumulative_capital_invested += sub_fiat
            self.portfolio.portfolio_cash += sub_fiat
            subscriptions_period_fiat += sub_fiat

        self.active_shares = sum(c.active_shares for c in self.cohorts)
        self.cumulative_subscriptions_fiat += subscriptions_period_fiat
        self._last_subscriptions_fiat = subscriptions_period_fiat

        # Scenario-level concentrated withdrawal shocks
        cohort_shock_map = ov.get("cohort_withdrawal_shocks", {})
        step_cohort_shocks = cohort_shock_map.get(it, cohort_shock_map.get(str(it), {}))
        uniform_shock_map = ov.get("uniform_withdrawal_shocks", {})
        step_uniform_shock = float(uniform_shock_map.get(it, uniform_shock_map.get(str(it), 0.0)))

        exit_fees_to_issuer_period = 0.0
        exit_fees_to_portfolio_period = 0.0
        tendered_shares_burned = 0.0
        new_fixed_claims_fiat = 0.0

        for cohort in self.cohorts:
            extra_cohort_shock = (float(step_cohort_shocks.get(cohort.cohort_id, 0.0)) + step_uniform_shock) * shock_multiplier
            if stoch_redemption_std > 0.0:
                extra_cohort_shock += max(0.0, float(self._rng.normal(0.0, stoch_redemption_std)))

            redeem_frac = cohort.compute_desired_redemption_fraction(
                iteration=it,
                nav_drawdown=drawdown_now,
                realized_net_yield_annual=realized_dist_yield_annual,
                queue_open_ratio=queue_ratio_current,
                redemption_multiplier=redemption_mult,
                extra_shock_fraction=extra_cohort_shock,
                reward_token_yield_boost_annual=reward_yield_boost_annual,
                periods_per_year=periods_per_year,
            )
            shares_to_redeem = cohort.active_shares * redeem_frac
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
                self.cumulative_token_transfers_shares += shares_to_redeem

                if not payment_pricing:
                    # Request-date pricing: shares become a fixed claim now, so the exit fee is charged now and
                    # split between issuer and portfolio (anti-dilution retention)
                    tendered_shares_burned += shares_to_redeem
                    new_fixed_claims_fiat += ticket.net_claim_fiat
                    cohort.cumulative_exit_fees_borne_fiat += ticket.exit_fee_fiat
                    issuer_fee_share = ticket.exit_fee_fiat * self.issuer.redemption_fee_to_issuer_pct
                    exit_fees_to_issuer_period += issuer_fee_share
                    exit_fees_to_portfolio_period += ticket.exit_fee_fiat - issuer_fee_share
            else:
                cohort.redemptions_requested_shares_period = 0.0
                cohort.redemptions_requested_net_fiat_period = 0.0

        self.active_shares = sum(c.active_shares for c in self.cohorts)
        if exit_fees_to_issuer_period > 0.0:
            self._pay_or_accrue("issuer_exit_fee", exit_fees_to_issuer_period)

        # 7. Liquidity Management: Asset Sales, Credit Facility Draw/Repay, Payables and Queue Settlement
        # Cash wanted now: payables + redemptions payable under the gate + target cash buffer
        _, nav_per_token_now = self.compute_current_nav()
        gate_pct = self.redemption_queue.gate_max_pct_nav_per_period
        queue_value = self.queue_value_fiat(nav_per_token_now)
        gate_cap = gate_pct * max(0.0, self.investor_equity()) if gate_pct is not None else float("inf")
        payable_target_this_period = min(queue_value, gate_cap)
        desired_buffer = max(0.0, self.underlying_asset_value * self.portfolio.target_cash_buffer_pct)
        cash_shortfall = max(
            0.0,
            self.total_payables + payable_target_this_period + desired_buffer - self.portfolio.portfolio_cash,
        )

        # Account for already pending settlements in transit so we don't over-liquidate the portfolio
        unbacked_shortfall = max(0.0, cash_shortfall - self.portfolio.pending_settlement_receivables)
        self.portfolio.initiate_asset_sale(
            target_net_cash=unbacked_shortfall,
            iteration=it,
            settlement_lag_override=settlement_lag_override,
            haircut_bps_override=haircut_bps_override,
        )

        # If immediate cash is still insufficient for payables and the payable redemptions, draw on the facility
        immediate_shortfall = max(
            0.0,
            self.total_payables + payable_target_this_period - self.portfolio.portfolio_cash,
        )
        facility_drawn_now = self.facility.draw(immediate_shortfall)
        self.portfolio.portfolio_cash += facility_drawn_now
        self._settle_payables()
        self._resolve_insolvency()

        # Settle the redemption queue in FIFO order; escrowed shares are redeemed at the NAV struck after
        # this period's sales and haircuts
        _, nav_per_token_settle = self.compute_current_nav()
        gate_cap = gate_pct * max(0.0, self.investor_equity()) if gate_pct is not None else float("inf")
        settlement = self.redemption_queue.settle_queue(
            available_cash=self.portfolio.portfolio_cash,
            gate_cap_fiat=gate_cap,
            nav_per_token=nav_per_token_settle,
            redemption_fee_rate=self.issuer.redemption_fee_rate,
            iteration=it,
        )
        redemptions_paid_fiat = settlement["paid"]
        self.portfolio.portfolio_cash -= redemptions_paid_fiat
        if payment_pricing:
            tendered_shares_burned += settlement["shares_redeemed"]
            issuer_fee_share = settlement["exit_fees"] * self.issuer.redemption_fee_to_issuer_pct
            exit_fees_to_issuer_period += issuer_fee_share
            exit_fees_to_portfolio_period += settlement["exit_fees"] - issuer_fee_share
            self._pay_or_accrue("issuer_exit_fee", issuer_fee_share)

        for cohort in self.cohorts:
            paid_c = settlement["cohort_paid"].get(cohort.cohort_id, 0.0)
            cohort.redemptions_paid_cash_period = paid_c
            cohort.cumulative_redemptions_received_cash_fiat += paid_c
            cohort.cumulative_exit_fees_borne_fiat += settlement["cohort_exit_fees"].get(cohort.cohort_id, 0.0)

        # Repay drawn facility from cash above the target buffer, then deploy surplus once the queue is clear
        repaid_now = 0.0
        if self.facility.drawn_balance > 1e-9:
            repaid_now = self.facility.repay(max(0.0, self.portfolio.portfolio_cash - desired_buffer))
            self.portfolio.portfolio_cash -= repaid_now

        if self.redemption_queue.unpaid_tickets_count == 0:
            desired_buffer = max(0.0, self.underlying_asset_value * self.portfolio.target_cash_buffer_pct)
            self.portfolio.deploy_excess_cash(min_cash_to_keep=desired_buffer)
        self._resolve_insolvency()

        # 8. Issuer P&L (accrual basis: fees are revenue when charged, whether paid now or carried as payables)
        self.issuer.mgmt_fee_period = mgmt_fee_due
        self.issuer.perf_fee_period = perf_fee_due
        self.issuer.exit_fee_issuer_period = exit_fees_to_issuer_period
        self.issuer.exit_fee_portfolio_period = exit_fees_to_portfolio_period
        self.issuer.admin_fee_period = admin_fee_due
        self.issuer.fixed_op_cost_period = self.issuer.fixed_operating_cost_annual / float(periods_per_year)
        self.issuer.variable_op_cost_period = (
            fee_basis_nav_total * (self.issuer.variable_operating_cost_bps / 10000.0) / float(periods_per_year)
        )
        self.issuer.facility_cost_issuer_period = issuer_facility_cost_paid
        self.issuer.reward_cost_period = reward_fiat_period

        self.issuer.issuer_revenue_period = mgmt_fee_due + perf_fee_due + exit_fees_to_issuer_period
        self.issuer.issuer_cost_period = (
            self.issuer.fixed_op_cost_period
            + self.issuer.variable_op_cost_period
            + issuer_admin_fee_paid
            + issuer_facility_cost_paid
            + reward_fiat_period
        )
        self.issuer.issuer_profit_period = self.issuer.issuer_revenue_period - self.issuer.issuer_cost_period

        self.issuer.cumulative_mgmt_fee += mgmt_fee_due
        self.issuer.cumulative_perf_fee += perf_fee_due
        self.issuer.cumulative_exit_fee_issuer += exit_fees_to_issuer_period
        self.issuer.cumulative_exit_fee_portfolio += exit_fees_to_portfolio_period
        self.issuer.cumulative_admin_fee_portfolio += portfolio_admin_fee_due
        self.issuer.cumulative_reward_cost += reward_fiat_period
        self.issuer.cumulative_issuer_revenue += self.issuer.issuer_revenue_period
        self.issuer.cumulative_issuer_cost += self.issuer.issuer_cost_period
        self.issuer.cumulative_issuer_profit += self.issuer.issuer_profit_period

        # 9. Final Period Valuation, Prices, Settlement Metrics, and Accounting Reconciliation
        self.nav_total, self.nav_per_token = self.compute_current_nav()
        self.supply = self.share_base
        self.price = self.nav_per_token
        self.executable_redemption_price, self.secondary_market_price = self.compute_executable_prices(
            self.nav_per_token
        )
        net_redemption_price = max(0.0, self.nav_per_token) * (1.0 - self.issuer.redemption_fee_rate)
        settlement_metrics = self.redemption_queue.compute_settlement_metrics(
            current_iteration=it, net_price_per_share=net_redemption_price
        )
        concentration_metrics = self.compute_concentration_metrics()
        coverage_ratio = self.liquidity_coverage_ratio()

        accrued_obligations = (
            expense_due
            + portfolio_facility_cost_due
            + mgmt_fee_due
            + portfolio_admin_fee_due
            + perf_fee_due
            + exit_fees_to_issuer_period
        )
        reconciliation = self.verify_accounting_reconciliation(
            opening_cash=opening_cash,
            opening_nav_total=opening_nav_total,
            opening_fixed_claims=opening_fixed_claims,
            opening_share_base=opening_share_base,
            opening_facility_drawn=opening_facility_drawn,
            opening_payables=opening_payables,
            gross_income=gross_income,
            valuation_change=val_change,
            accrued_obligations=accrued_obligations,
            haircut_loss=self.portfolio.realized_liquidation_loss_period,
            subscriptions_fiat=subscriptions_period_fiat,
            settled_asset_sales_fiat=self.portfolio.settled_asset_sales_period,
            new_investments_fiat=self.portfolio.new_investments_period,
            facility_drawn_fiat=facility_drawn_now,
            facility_repaid_fiat=repaid_now,
            cash_distributions_paid_fiat=distributions_cash_paid_period,
            redemptions_paid_fiat=redemptions_paid_fiat,
            new_fixed_claims_fiat=new_fixed_claims_fiat,
            shares_minted=subscription_shares_minted + reinvested_shares_minted,
            shares_burned=tendered_shares_burned,
        )
        self._reconciliation_log.append(reconciliation)

        # Investor returns: per-unit time-weighted return from NAV per share plus distributions per share
        if opening_nav_per_token > 1e-12:
            period_return_pct = (self.nav_per_token + distribution_per_share) / opening_nav_per_token - 1.0
        else:
            period_return_pct = 0.0
        self.total_return_index *= max(0.0, 1.0 + period_return_pct)
        self._total_return_peak = max(self._total_return_peak, self.total_return_index)
        total_return_drawdown = max(0.0, 1.0 - self.total_return_index / max(1e-12, self._total_return_peak))
        self.max_total_return_drawdown = max(self.max_total_return_drawdown, total_return_drawdown)

        years_elapsed = float(it) / float(periods_per_year)
        if years_elapsed > 0 and self.total_return_index > 0:
            investor_annualised_return_pct = self.total_return_index ** (1.0 / years_elapsed) - 1.0
        else:
            investor_annualised_return_pct = -1.0

        # Investor-base dollar return (all investors, queued capital included; flows at period end)
        total_initial_capital = sum(c.initial_capital for c in self.cohorts)
        total_capital_contributed = total_initial_capital + self.cumulative_subscriptions_fiat
        investor_ending_economic_value = (
            self.investor_equity()
            + self.cumulative_distributions_cash_fiat
            + self.redemption_queue.cumulative_payments
        )
        investor_net_profit_fiat = investor_ending_economic_value - total_capital_contributed
        investor_roi_on_total_contributed_pct = investor_net_profit_fiat / max(1.0, total_capital_contributed)
        period_net_profit_fiat = investor_net_profit_fiat - self._prev_investor_net_profit_fiat
        self._prev_investor_net_profit_fiat = investor_net_profit_fiat
        self._base_return_factor *= max(1e-9, 1.0 + period_net_profit_fiat / max(1.0, opening_investor_equity))
        investor_base_dollar_return_annualised_pct = (
            self._base_return_factor ** (1.0 / years_elapsed) - 1.0 if years_elapsed > 0 else 0.0
        )
        self._investor_cash_flows.append(
            -subscriptions_period_fiat + distributions_cash_paid_period + redemptions_paid_fiat
        )

        secondary_discount = (
            1.0 - self.secondary_market_price / self.nav_per_token if self.nav_per_token > 1e-12 else 0.0
        )
        row = {
            "iteration": it,
            "underlying_asset_value": self.underlying_asset_value,
            "invested_assets": self.portfolio.invested_assets,
            "available_cash": self.portfolio.portfolio_cash,
            "pending_settlement_receivables": self.portfolio.pending_settlement_receivables,
            "nav_total": self.nav_total,
            "nav_per_token": self.nav_per_token,
            "active_shares": self.active_shares,
            "escrowed_shares": self.redemption_queue.escrowed_shares,
            "payables_total": self.total_payables,
            "executable_redemption_price": self.executable_redemption_price,
            "secondary_market_price": self.secondary_market_price,
            "exit_discount_vs_nav": secondary_discount,
            "expected_wait_periods": self.expected_wait,
            "gross_income_period": self.portfolio.gross_income_period,
            "portfolio_expense_period": expense_due,
            "unrealized_valuation_change_period": self.portfolio.unrealized_valuation_change_period,
            "realized_liquidation_loss_period": self.portfolio.realized_liquidation_loss_period,
            "cumulative_realized_liquidation_loss": self.portfolio.cumulative_realized_liquidation_loss,
            "distribution_per_share": distribution_per_share,
            "distributions_total_period": distributions_cash_paid_period + distributions_reinvested_period,
            "distributions_cash_period": distributions_cash_paid_period,
            "distributions_reinvested_period": distributions_reinvested_period,
            "cumulative_distributions_total_fiat": self.cumulative_distributions_total_fiat,
            "cumulative_distributions_cash_fiat": self.cumulative_distributions_cash_fiat,
            "total_return_index": self.total_return_index,
            "total_return_drawdown": total_return_drawdown,
            "investor_net_profit_fiat": investor_net_profit_fiat,
            "investor_period_return_pct": period_return_pct,
            "investor_roi_on_total_contributed_pct": investor_roi_on_total_contributed_pct,
            "investor_cumulative_return_pct": self.total_return_index - 1.0,
            "investor_annualised_return_pct": investor_annualised_return_pct,
            "investor_base_dollar_return_annualised_pct": investor_base_dollar_return_annualised_pct,
            "investor_external_cash_flow_fiat": self._investor_cash_flows[-1],
            "subscriptions_period_fiat": subscriptions_period_fiat,
            "redemption_requests_gross_period": self.redemption_queue.requests_gross_period,
            "redemption_requests_net_period": self.redemption_queue.requests_net_period,
            "redemption_requests_shares_period": self.redemption_queue.requests_shares_period,
            "redemptions_paid_period": redemptions_paid_fiat,
            "unpaid_redemption_obligations": self.queue_value_fiat(),
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
            "issuer_mgmt_fee_period": mgmt_fee_due,
            "issuer_perf_fee_period": perf_fee_due,
            "issuer_exit_fee_period": exit_fees_to_issuer_period,
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
            "liquidity_coverage_ratio": coverage_ratio,
            "claims_written_down_period": self._writedowns_period,
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
        opening_nav_total: float,
        opening_fixed_claims: float,
        opening_share_base: float,
        opening_facility_drawn: float,
        opening_payables: float,
        gross_income: float,
        valuation_change: float,
        accrued_obligations: float,
        haircut_loss: float,
        subscriptions_fiat: float,
        settled_asset_sales_fiat: float,
        new_investments_fiat: float,
        facility_drawn_fiat: float,
        facility_repaid_fiat: float,
        cash_distributions_paid_fiat: float,
        redemptions_paid_fiat: float,
        new_fixed_claims_fiat: float,
        shares_minted: float,
        shares_burned: float,
        tol: float = 1e-4,
    ) -> Dict[str, Any]:
        """
        Verify exact financial accounting conservation at the current iteration:
        1. Equity roll-forward (accrual basis): opening NAV + income + valuation change
           - accrued fees and expenses - liquidation haircuts - cash distributions
           + subscriptions - redemption cash paid (payment-date pricing) or new fixed
           claims (request-date pricing) + claims written down == assets - liabilities.
           Unpaid fees that were neither paid nor carried as payables would break it.
        2. Cash flow conservation: Opening Cash + Inflows - Outflows == Ending Cash.
        3. Redemption queue conservation: fixed claims roll forward (request-date pricing).
        4. Credit facility conservation: Opening Drawn + Drawn - Repaid - Written Down == Ending Drawn.
        5. Payables conservation: Opening + Accrued Unpaid - Paid - Written Down == Ending.
        6. Token supply: Opening Share Base + Minted - Burned == Ending Share Base.
        7. Non-negativity: Cash, Invested Assets, Facility, Payables, and Shares >= 0.
        """
        payment_pricing = self.redemption_queue.pricing_mode == "payment_date_nav"

        # 1. Equity roll-forward against the balance sheet
        expected_nav = (
            opening_nav_total
            + gross_income
            + valuation_change
            - accrued_obligations
            - haircut_loss
            - cash_distributions_paid_fiat
            + subscriptions_fiat
            - (redemptions_paid_fiat if payment_pricing else new_fixed_claims_fiat)
            + self._writedowns_period
        )
        balance_sheet_nav = self.underlying_asset_value - self.total_liabilities
        equity_diff = abs(expected_nav - balance_sheet_nav)
        balance_sheet_diff = abs(balance_sheet_nav - self.nav_total)
        equity_ok = equity_diff <= tol and balance_sheet_diff <= tol

        # 2. Cash flow check
        expected_ending_cash = (
            opening_cash
            + subscriptions_fiat
            + gross_income
            + settled_asset_sales_fiat
            + facility_drawn_fiat
            - new_investments_fiat
            - cash_distributions_paid_fiat
            - redemptions_paid_fiat
            - self._cash_paid_obligations_period
            - facility_repaid_fiat
        )
        cash_diff = abs(expected_ending_cash - self.portfolio.portfolio_cash)
        cash_ok = cash_diff <= tol

        # 3. Redemption queue liability check (fixed claims)
        expected_ending_queue = (
            opening_fixed_claims
            + new_fixed_claims_fiat
            - (0.0 if payment_pricing else redemptions_paid_fiat)
            - self.redemption_queue.writedowns_period
        )
        queue_diff = abs(expected_ending_queue - self.redemption_queue.fixed_claims_fiat)
        queue_ok = queue_diff <= tol

        # 4. Facility principal check
        expected_facility_drawn = (
            opening_facility_drawn + facility_drawn_fiat - facility_repaid_fiat - self.facility.writedown_period
        )
        facility_diff = abs(expected_facility_drawn - self.facility.drawn_balance)
        facility_ok = facility_diff <= tol

        # 5. Payables check
        expected_payables = (
            opening_payables + self._payables_accrued_period - self._payables_paid_period - self._payables_writedown_period
        )
        payables_diff = abs(expected_payables - self.total_payables)
        payables_ok = payables_diff <= tol

        # 6. Token supply check
        supply_diff = abs(opening_share_base + shares_minted - shares_burned - self.share_base)
        supply_ok = supply_diff <= 1e-6 * max(1.0, opening_share_base)

        # 7. Non-negativity check
        non_negative_ok = (
            self.portfolio.portfolio_cash >= -tol
            and self.portfolio.invested_assets >= -tol
            and self.facility.drawn_balance >= -tol
            and self.facility.available_capacity >= -tol
            and self.total_payables >= -tol
            and self.active_shares >= -tol
            and self.redemption_queue.escrowed_shares >= -tol
        )

        all_ok = bool(equity_ok and cash_ok and queue_ok and facility_ok and payables_ok and supply_ok and non_negative_ok)
        if not all_ok:
            raise AssertionError(
                f"Financial reconciliation failed at step {self.iteration}: "
                f"equity_diff={equity_diff:.6f}, bs_diff={balance_sheet_diff:.6f}, cash_diff={cash_diff:.6f}, "
                f"queue_diff={queue_diff:.6f}, fac_diff={facility_diff:.6f}, payables_diff={payables_diff:.6f}, "
                f"supply_diff={supply_diff:.6f}, non_neg={non_negative_ok}"
            )

        return {
            "iteration": self.iteration,
            "all_reconciled": all_ok,
            "equity_rollforward_diff": float(equity_diff),
            "balance_sheet_diff": float(balance_sheet_diff),
            "cash_flow_diff": float(cash_diff),
            "redemption_queue_diff": float(queue_diff),
            "facility_balance_diff": float(facility_diff),
            "payables_diff": float(payables_diff),
            "token_supply_diff": float(supply_diff),
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

    def compute_breakeven(self) -> Dict[str, Any]:
        """Analytical break-even AUM for this product's issuer under its configured terms."""
        return self.issuer.compute_breakeven_aum(
            expected_gross_portfolio_return_annual=self.portfolio.gross_yield_annual,
            portfolio_expense_annual=self.portfolio.portfolio_expense_annual,
            expected_annual_redemption_turnover=self.expected_annual_redemption_turnover,
            facility_max_capacity=self.facility.base_max_capacity,
            facility_commitment_fee_annual=self.facility.commitment_fee_annual,
            facility_cost_bearer=self.facility.cost_bearer,
            invested_fraction=1.0 - self.portfolio.target_cash_buffer_pct,
            reward_budget_annual_fiat=self.reward_token_annual_budget_fiat if self.reward_token_enabled else 0.0,
        )

    def get_registered_locks(self) -> List[Dict[str, Any]]:
        """
        Implement HARD and SOFT parameter/solvency locks per `.agent/rules/tokenomist_review_rules.md`.
        """
        def _lock_accounting() -> Tuple[bool, str]:
            if not self._reconciliation_log:
                return True, "No steps executed yet"
            all_ok = all(r["all_reconciled"] for r in self._reconciliation_log)
            return all_ok, f"Checked {len(self._reconciliation_log)} steps for accrual equity, cash, payables and supply conservation"

        def _lock_net_yield_positive() -> Tuple[bool, str]:
            net_yield = (
                self.portfolio.gross_yield_annual * (1.0 - self.issuer.income_share_fee_rate)
                - self.portfolio.portfolio_expense_annual
                - self.issuer.management_fee_annual
                - (self.issuer.platform_admin_fee_annual if self.issuer.platform_admin_cost_bearer == "portfolio" else 0.0)
            )
            return net_yield > 0.0, f"Expected net portfolio yield before perf fee = {net_yield * 100:.2f}% p.a."

        def _lock_payment_sla() -> Tuple[bool, str]:
            metrics = self.redemption_queue.compute_settlement_metrics(
                current_iteration=self.iteration,
                net_price_per_share=max(0.0, self.nav_per_token) * (1.0 - self.issuer.redemption_fee_rate),
            )
            return (
                bool(metrics["sla_met"]),
                f"Max time to full payment = {metrics['max_time_to_payment_periods']:.1f} periods "
                f"(SLA <= {self.redemption_queue.payment_sla_periods} periods)",
            )

        def _lock_issuer_breakeven() -> Tuple[bool, str]:
            be = self.compute_breakeven()
            passed = self.issuer.cumulative_issuer_profit >= 0.0
            be_text = "not achievable (margin <= 0)" if be["breakeven_aum"] is None else f"${be['breakeven_aum']:,.0f}"
            return (
                passed,
                f"Cumulative issuer profit = ${self.issuer.cumulative_issuer_profit:,.0f} "
                f"(Analytical break-even AUM = {be_text})",
            )

        return [
            {
                "id": "L1_ACCOUNTING_CONSERVATION",
                "type": "HARD",
                "description": "Cash, assets, claims, payables, and token supply reconcile at every step without negative balances",
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

        net_redemption_price = max(0.0, self.nav_per_token) * (1.0 - self.issuer.redemption_fee_rate)
        settlement = self.redemption_queue.compute_settlement_metrics(
            current_iteration=self.iteration, net_price_per_share=net_redemption_price
        )
        breakeven = self.compute_breakeven()
        locks = self.check_solvency_locks()

        last = df.iloc[-1].to_dict() if not df.empty else {}
        min_nav_per_token = float(df["nav_per_token"].min()) if not df.empty else self.initial_nav_per_token
        min_secondary_price = float(df["secondary_market_price"].min()) if not df.empty else self.initial_nav_per_token
        min_cash_buffer_ratio = float(df["cash_plus_facility_to_nav_ratio"].min()) if not df.empty else 0.0
        min_coverage_ratio = float(df["liquidity_coverage_ratio"].min()) if not df.empty else 0.0
        peak_unpaid_queue = float(df["unpaid_redemption_obligations"].max()) if not df.empty else 0.0
        peak_facility_drawn = float(df["facility_drawn_balance"].max()) if not df.empty else 0.0
        max_exit_discount = float(df["exit_discount_vs_nav"].max()) if not df.empty else 0.0

        # Money-weighted return (IRR) of the whole investor base: initial capital out, then
        # subscriptions out and distributions/redemptions in, with ending equity as terminal value
        cash_flows = [-sum(c.initial_capital for c in self.cohorts)] + list(self._investor_cash_flows)
        if len(cash_flows) > 1:
            cash_flows[-1] += self.investor_equity()
        irr_period = _internal_rate_of_return(cash_flows)
        investor_irr_annualised = (
            (1.0 + irr_period) ** periods_per_year - 1.0 if irr_period is not None and irr_period > -1.0 else None
        )

        # Forced-exit return: hold from inception and sell at the worst secondary price relative to NAV
        forced_exit_return = None
        if not df.empty and max_exit_discount <= 1e-12:
            # Never below NAV: exiting at any time earns the ordinary return
            forced_exit_return = float(last.get("investor_annualised_return_pct", 0.0))
        elif not df.empty:
            worst = int(df["exit_discount_vs_nav"].idxmax())
            worst_row = df.iloc[worst]
            worst_years = float(worst_row["iteration"]) / float(periods_per_year)
            exit_value = float(worst_row["total_return_index"]) * (1.0 - float(worst_row["exit_discount_vs_nav"]))
            if exit_value > 0.0 and worst_years > 0.0:
                forced_exit_return = exit_value ** (1.0 / worst_years) - 1.0

        reward_yield_annual = (
            (self.reward_token_annual_budget_fiat / max(1.0, self.portfolio.initial_aum))
            if self.reward_token_enabled
            else 0.0
        )

        cohort_summaries = []
        for c in self.cohorts:
            ending_active_val = c.active_shares * self.nav_per_token
            unpaid_claim = sum(
                t.remaining_value_fiat(net_redemption_price)
                for t in self.redemption_queue.tickets
                if t.cohort_id == c.cohort_id and not t.is_settled
            )
            total_econ_val = (
                ending_active_val
                + unpaid_claim
                + c.cumulative_distributions_cash_fiat
                + c.cumulative_redemptions_received_cash_fiat
            )
            net_gain = total_econ_val - c.cumulative_capital_invested
            cohort_summaries.append(
                {
                    "cohort_id": c.cohort_id,
                    "name": c.name,
                    "num_holders": c.num_holders,
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
            "reward_yield_annual": reward_yield_annual,
            "investor_net_profit_fiat": float(last.get("investor_net_profit_fiat", 0.0)),
            "investor_roi_on_total_contributed_pct": float(last.get("investor_roi_on_total_contributed_pct", 0.0)),
            "investor_cumulative_return_pct": self.total_return_index - 1.0,
            "investor_annualised_return_pct": float(last.get("investor_annualised_return_pct", 0.0)),
            "investor_irr_annualised_pct": investor_irr_annualised,
            "investor_base_dollar_return_annualised_pct": float(last.get("investor_base_dollar_return_annualised_pct", 0.0)),
            "forced_exit_return_annualised_pct": forced_exit_return,
            "max_exit_discount_vs_nav": max_exit_discount,
            "max_total_return_drawdown": self.max_total_return_drawdown,
            "risk_free_rate_annual": self._effective_risk_free_rate(),
            # Asset & NAV vs executable price
            "initial_aum": self.portfolio.initial_aum,
            "ending_underlying_asset_value": self.underlying_asset_value,
            "ending_invested_assets": self.portfolio.invested_assets,
            "ending_available_cash": self.portfolio.portfolio_cash,
            "ending_pending_settlement_receivables": self.portfolio.pending_settlement_receivables,
            "ending_payables_fiat": self.total_payables,
            "ending_nav_total": self.nav_total,
            "ending_nav_per_token": self.nav_per_token,
            "min_nav_per_token": min_nav_per_token,
            "ending_executable_redemption_price": self.executable_redemption_price,
            "ending_secondary_market_price": self.secondary_market_price,
            "min_secondary_market_price": min_secondary_price,
            "cumulative_unrealized_valuation_change": self.portfolio.cumulative_unrealized_valuation_change,
            "cumulative_realized_liquidation_loss": self.portfolio.cumulative_realized_liquidation_loss,
            "cumulative_claims_written_down_fiat": (
                self.redemption_queue.cumulative_writedowns
                + self.cumulative_payables_writedown
                + self.facility.cumulative_writedown
            ),
            # Issuer economics & break-even scale
            "issuer_cumulative_revenue_fiat": self.issuer.cumulative_issuer_revenue,
            "issuer_cumulative_mgmt_fee_fiat": self.issuer.cumulative_mgmt_fee,
            "issuer_cumulative_perf_fee_fiat": self.issuer.cumulative_perf_fee,
            "issuer_cumulative_exit_fee_fiat": self.issuer.cumulative_exit_fee_issuer,
            "issuer_cumulative_reward_cost_fiat": self.issuer.cumulative_reward_cost,
            "portfolio_retained_exit_fee_fiat": self.issuer.cumulative_exit_fee_portfolio,
            "issuer_cumulative_cost_fiat": self.issuer.cumulative_issuer_cost,
            "issuer_cumulative_profit_fiat": self.issuer.cumulative_issuer_profit,
            "issuer_annualised_profit_fiat": self.issuer.cumulative_issuer_profit / years,
            "issuer_profitable": self.issuer.cumulative_issuer_profit >= 0.0,
            "breakeven_aum_fiat": breakeven["breakeven_aum"],
            "breakeven_details": breakeven,
            "reference_real_aum_fiat": self.reference_real_aum_fiat,
            "cost_attribution_schedule": self.issuer.get_cost_attribution_schedule(self.facility.cost_bearer),
            # Liquidity, queue, and financing costs
            "queue_pricing_mode": self.redemption_queue.pricing_mode,
            "cumulative_subscriptions_fiat": self.cumulative_subscriptions_fiat,
            "cumulative_redemption_requests_gross_fiat": self.redemption_queue.cumulative_requests_gross,
            "cumulative_redemption_requests_net_fiat": self.redemption_queue.cumulative_requests_net,
            "cumulative_redemptions_paid_fiat": self.redemption_queue.cumulative_payments,
            "ending_unpaid_redemption_obligations_fiat": self.queue_value_fiat(),
            "peak_unpaid_redemption_obligations_fiat": peak_unpaid_queue,
            "max_time_to_payment_periods": settlement["max_time_to_payment_periods"],
            "weighted_avg_time_to_payment_periods": settlement["weighted_avg_time_to_payment_periods"],
            "open_queue_max_age_periods": settlement["open_queue_max_age_periods"],
            "open_queue_censored_fiat": settlement["open_queue_censored_fiat"],
            "payment_sla_periods": self.redemption_queue.payment_sla_periods,
            "payment_sla_met": settlement["sla_met"],
            "facility_max_capacity_fiat": self.facility.max_capacity,
            "ending_facility_drawn_fiat": self.facility.drawn_balance,
            "ending_facility_available_fiat": self.facility.available_capacity,
            "peak_facility_drawn_fiat": peak_facility_drawn,
            "cumulative_facility_financing_cost_fiat": self.facility.cumulative_financing_cost,
            "total_liquidity_and_financing_costs_fiat": (
                self.facility.cumulative_financing_cost + self.portfolio.cumulative_realized_liquidation_loss
            ),
            "min_cash_plus_facility_to_nav_ratio": min_cash_buffer_ratio,
            "min_liquidity_coverage_ratio": min_coverage_ratio,
            "liquidity_buffer_floor_met": min_coverage_ratio >= self.min_liquidity_buffer_pct_nav,
            # Verification & cohorts
            "all_steps_reconciled": all(r["all_reconciled"] for r in self._reconciliation_log),
            "solvency_locks": locks,
            "cohorts": cohort_summaries,
        }
        investor_score = compute_investor_score(out_dict, risk_free_rate_annual=self._effective_risk_free_rate())
        sponsor = compute_sponsor_viability(out_dict)
        out_dict["investor_scorecard"] = investor_score
        out_dict["sponsor_viability"] = sponsor
        for key in INVESTOR_PILLAR_KEYS:
            out_dict[key] = investor_score[key]
        out_dict["investor_score_100"] = investor_score["investor_score_100"]
        out_dict["investor_score_band"] = investor_score["investor_score_band"]
        out_dict["excess_return_annual"] = investor_score["excess_return_annual"]
        out_dict["sponsor_viability_score_100"] = sponsor["sponsor_viability_score_100"]
        out_dict["sponsor_aum_headroom"] = sponsor["aum_headroom"]
        return out_dict

    def _effective_risk_free_rate(self) -> float:
        return self.risk_free_rate_annual + float(self.scenario_overrides.get("risk_free_delta_annual", 0.0))


def _internal_rate_of_return(cash_flows: List[float], lo: float = -0.99, hi: float = 1.0) -> Optional[float]:
    """Per-period IRR by bisection; None when the cash flows do not bracket a root."""
    def npv(rate: float) -> float:
        return sum(cf / (1.0 + rate) ** t for t, cf in enumerate(cash_flows))

    f_lo, f_hi = npv(lo), npv(hi)
    if not (math.isfinite(f_lo) and math.isfinite(f_hi)) or f_lo * f_hi > 0.0:
        return None
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        f_mid = npv(mid)
        if f_lo * f_mid <= 0.0:
            hi, f_hi = mid, f_mid
        else:
            lo, f_lo = mid, f_mid
    return 0.5 * (lo + hi)


# ---------------------------------------------------------------------------
# 8. Investor Score & Sponsor Viability
# ---------------------------------------------------------------------------

INVESTOR_PILLAR_KEYS: Tuple[str, ...] = (
    "risk_adjusted_yield_score",
    "exit_liquidity_score",
    "capital_stability_score",
    "liquidity_resilience_score",
)

INVESTOR_SCORE_WEIGHTS: Dict[str, float] = {
    "risk_adjusted_yield_score": 0.30,
    "exit_liquidity_score": 0.30,
    "capital_stability_score": 0.20,
    "liquidity_resilience_score": 0.20,
}

# Normalisation scales (modelling choices, reported with the scores)
INVESTOR_SCORE_SCALES: Dict[str, float] = {
    "excess_return_full_marks": 0.05,
    "wait_decay_periods": 2.0,
    "exit_discount_decay": 0.04,
    "drawdown_decay": 0.05,
    "coverage_decay": 0.10,
}

SCORE_BANDS: Tuple[Tuple[float, str], ...] = ((80.0, "80-100"), (65.0, "65-80"), (50.0, "50-65"), (0.0, "0-50"))


def score_band(score: float) -> str:
    """Neutral score band label (not a credit rating)."""
    for floor, label in SCORE_BANDS:
        if score >= floor:
            return label
    return SCORE_BANDS[-1][1]


def compute_investor_score(
    outcomes: Dict[str, Any],
    risk_free_rate_annual: float,
    weights: Optional[Dict[str, float]] = None,
    scales: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    """
    Investor score (0-100) for one simulated path.

    Sponsor economics are excluded: fees enter only through the investor's net
    return, wait and exit costs, so raising a fee can never raise the score.
    Every pillar is continuous in its inputs (no thresholds or cliffs).

    Pillars:
    1. `risk_adjusted_yield_score`: per-unit TWR (plus any reward-token yield) in
       excess of the risk-free rate; `excess_return_full_marks` scores 100 and
       zero or negative excess scores 0.
    2. `exit_liquidity_score`: half from the dollar-weighted wait to payment and
       half from the largest immediate-exit discount to NAV (exit fees included),
       each with exponential decay.
    3. `capital_stability_score`: exponential decay in the maximum drawdown of the
       per-unit total-return index.
    4. `liquidity_resilience_score`: minimum same-period liquidity coverage (cash,
       undrawn facility, receivables due next period and assets that settle within
       the period) relative to investor equity.
    """
    def _num(val: Any, default: float = 0.0) -> float:
        if val is None:
            return default
        try:
            fval = float(val)
        except (TypeError, ValueError):
            return default
        return default if math.isnan(fval) else fval

    w = dict(INVESTOR_SCORE_WEIGHTS if weights is None else weights)
    sc = dict(INVESTOR_SCORE_SCALES if scales is None else scales)

    twr = _num(outcomes.get("investor_annualised_return_pct"), -1.0)
    reward_yield = _num(outcomes.get("reward_yield_annual"), 0.0)
    excess = twr + reward_yield - _num(risk_free_rate_annual, 0.0)
    yield_score = max(0.0, min(100.0, 100.0 * excess / sc["excess_return_full_marks"]))

    wait = max(0.0, _num(outcomes.get("weighted_avg_time_to_payment_periods"), 0.0))
    exit_discount = max(0.0, _num(outcomes.get("max_exit_discount_vs_nav"), 0.0))
    exit_score = 100.0 * (
        0.5 * math.exp(-wait / sc["wait_decay_periods"]) + 0.5 * math.exp(-exit_discount / sc["exit_discount_decay"])
    )

    drawdown = max(0.0, _num(outcomes.get("max_total_return_drawdown"), 0.0))
    stability_score = 100.0 * math.exp(-drawdown / sc["drawdown_decay"])

    coverage = max(0.0, _num(outcomes.get("min_liquidity_coverage_ratio"), 0.0))
    resilience_score = 100.0 * (1.0 - math.exp(-coverage / sc["coverage_decay"]))

    pillars = {
        "risk_adjusted_yield_score": yield_score,
        "exit_liquidity_score": exit_score,
        "capital_stability_score": stability_score,
        "liquidity_resilience_score": resilience_score,
    }
    total_weight = sum(w.values())
    composite = sum(w[k] * pillars[k] for k in INVESTOR_PILLAR_KEYS) / max(1e-12, total_weight)
    return {
        **{k: round(v, 1) for k, v in pillars.items()},
        "investor_score_100": round(composite, 1),
        "investor_score_band": score_band(composite),
        "excess_return_annual": excess,
        "risk_free_rate_annual": _num(risk_free_rate_annual, 0.0),
        "weights": w,
        "scales": sc,
    }


def compute_sponsor_viability(outcomes: Dict[str, Any]) -> Dict[str, Any]:
    """
    Sponsor (issuer) viability, reported separately from the investor score.

    AUM headroom = reference AUM / analytical break-even AUM, where the reference is
    the product's documented real AUM when known and the simulated starting AUM
    otherwise. Score = 50 + 50 * log10(headroom), clipped to [0, 100]: 1x headroom
    scores 50, 10x scores 100, 0.1x scores 0. Not achievable break-even scores 0.
    """
    breakeven = outcomes.get("breakeven_aum_fiat")
    reference = outcomes.get("reference_real_aum_fiat") or outcomes.get("initial_aum")
    if breakeven is None or not reference or float(breakeven) <= 0.0:
        headroom = None
        score = 0.0
    else:
        headroom = float(reference) / float(breakeven)
        score = max(0.0, min(100.0, 50.0 + 50.0 * math.log10(max(1e-12, headroom))))
    return {
        "sponsor_viability_score_100": round(score, 1),
        "aum_headroom": headroom,
        "reference_aum_fiat": None if not reference else float(reference),
        "reference_is_documented_real_aum": bool(outcomes.get("reference_real_aum_fiat")),
        "breakeven_aum_fiat": breakeven,
        "issuer_annualised_profit_at_simulated_aum_fiat": outcomes.get("issuer_annualised_profit_fiat"),
    }
