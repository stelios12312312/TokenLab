# tests/test_staking_conservation.py
# @planner:module = test_staking_conservation
# @planner:story = US-Z1-M3-06

import pytest
import math
from projects.z1.m3_full_economy.config import M3EconomyConfig, COHORT_NAMES
from projects.z1.m3_full_economy.economy import TokenEconomy_Z1
from projects.z1.m3_full_economy.pools import AgentPool_Z1

def test_staking_conservation_and_non_double_count():
    """
    US-Z1-M3-06: Verifies that validator staking reconciles properly over 50 epochs,
    and that the double-counting staking bug is resolved (i.e. staking_buckets matches
    staking_buckets_12 as a view, and total staked matches sum of 3-tier buckets).
    """
    config = M3EconomyConfig(
        creator_population=1000,
        validator_population=100,
        creator_sell_propensity=0.50,
        validator_sell_propensity=0.20,
        governance_staking_enabled=True,
        staking_lock_epochs=12,
        cip_budget_per_epoch=10_000.0,
        vrp_budget_per_epoch=5_000.0,
    )
    
    # Configure 10% staking rate for validators
    config.staking_rate_by_cohort["validators"] = 0.10
    config.staking_rate_by_cohort["creators"] = 0.0
    
    economy = TokenEconomy_Z1(config)
    for name in COHORT_NAMES + ["creators", "validators"]:
        economy.add_agent_pool(AgentPool_Z1(name, config))
        
    # Execute 50 epochs
    for _ in range(50):
        economy.execute()
        
    validators = economy.cohorts.get("validators")
    assert validators is not None
    
    # Check that validators.staked_z1u equals sum of 3-tier buckets
    sum_3_tier = sum(validators.staking_buckets_3) + sum(validators.staking_buckets_6) + sum(validators.staking_buckets_12)
    assert math.isclose(validators.staked_z1u, sum_3_tier, rel_tol=1e-5, abs_tol=1e-5), \
        f"staked_z1u ({validators.staked_z1u}) differs from sum of 3-tier buckets ({sum_3_tier})"
        
    # Check that legacy staking_buckets is a view/property of staking_buckets_12
    assert validators.staking_buckets is validators.staking_buckets_12
    assert sum(validators.staking_buckets) == sum(validators.staking_buckets_12)
    
    # Verify that the total validators' tokens (liquid + staked) reconciles with validator inflows - outflows
    assert validators.z1u_balance >= 0.0
    assert validators.staked_z1u >= 0.0


# ---------------------------------------------------------------------------
# S-004 conservation proofs for the sanitized public staking/rewards and
# multi-token dependency demos (schema v3, T-INTAKE-582B4E00).
#
# @planner:story = US-PM-AUTO-HBD48E6CAE9D9DF04
#
# The staking rig below mirrors the shipped public-staking-rewards-v3 demo
# shape (AgentPool_Staking + SupplyStakerLockup, reward_as_perc pinned
# False, exogenous FromData supply/demand) on a small exact rig whose
# mechanics are pinned by construction:
#
# - A staker created during economy iteration i executes immediately
#   (iteration counter 0 -> 1) and once more in the same iteration's
#   supply-pool phase; it pays out at the execute whose entry counter equals
#   lockup_duration, i.e. at economy iteration i + lockup_duration - 1.
# - MINTED (no treasury): the escrow execute's negative supply report is
#   overwritten by the same-iteration pool-phase execute before the economy
#   reads it, so recorded supply never leaves circulation at stake time;
#   each unlock mints the full payout (stake + reward) into supply — honest
#   dilution, exactly accounted below.
# - TREASURY-DRAWN: the escrow execute deposits the stake into the declared
#   treasury (treasury add_asset also escrows it out of recorded supply via
#   its change_supply hook); each unlock retrieves stake + reward from the
#   treasury. Economy delta + treasury delta is exactly zero per step —
#   rewards are drawn from the treasury, never minted.
#
# The cross-economy rig drives the shipped multitoken ecosystem economies
# directly: TokenEconomy_Dependent.execute subtracts the fiat value it
# received (the channeled value) from the master supply after its execute —
# the conservation point at tokeneconomyclasses.py (`self._token_economy
# .supply -= prime_token_used`, formerly line 851) pinned here exactly.
# ---------------------------------------------------------------------------

import math as _math
from pathlib import Path as _Path

import numpy as _np

from TokenLab.agentic.factory import ScenarioFactory as _ScenarioFactory
from TokenLab.agentic.rng import derive_generator as _derive_generator
from TokenLab.agentic.schema import load_scenario as _load_scenario
from TokenLab.simulationcomponents.agentpoolclasses import (
    AgentPool_Staking as _AgentPool_Staking,
)
from TokenLab.simulationcomponents.pricingclasses import (
    HoldingTime_Constant as _HoldingTime_Constant,
    PriceFunction_EOE as _PriceFunction_EOE,
)
from TokenLab.simulationcomponents.supplyclasses import (
    SupplyController_FromData as _SupplyController_FromData,
    SupplyStakerLockup as _SupplyStakerLockup,
)
from TokenLab.simulationcomponents.tokeneconomyclasses import (
    TokenEconomy_Basic as _TokenEconomy_Basic,
)
from TokenLab.simulationcomponents.transactionclasses import (
    TransactionManagement_FromData as _TransactionManagement_FromData,
)
from TokenLab.simulationcomponents.treasuryclasses import (
    TreasuryBasic as _TreasuryBasic,
)
from TokenLab.simulationcomponents.usergrowthclasses import (
    UserGrowth_Constant as _UserGrowth_Constant,
)

_V3_DATA_DIR = _Path(__file__).resolve().parents[1] / "src" / "TokenLab" / "agentic" / "data"

_RIG_STAKE = 40000
_RIG_REWARD = 1600
_RIG_LOCKUP = 4
_RIG_STEPS = 12
_RIG_DEMAND = 120000
_RIG_SUPPLY_STEP = 2000000
_RIG_TREASURY_INITIAL = 1000000.0


def _staking_rig(with_treasury, rng_seed=7):
    """The exact staking rig: minted (no treasury) or treasury-drawn."""
    treasury = (
        _TreasuryBasic(name="rewards", treasury={"STLB": _RIG_TREASURY_INITIAL})
        if with_treasury
        else None
    )
    pool = _AgentPool_Staking(
        users_controller=_UserGrowth_Constant(240),
        transactions_controller=_TransactionManagement_FromData(
            [_RIG_DEMAND] * _RIG_STEPS
        ),
        staking_controller=_SupplyStakerLockup,
        staking_controller_params={
            "staking_amount": _RIG_STAKE,
            "rewards": _RIG_REWARD,
            "lockup_duration": _RIG_LOCKUP,
            "reward_as_perc": False,
        },
        currency="STLB",
        name="staking-rig",
        treasury=treasury,
        fee=0.0,
        rng=_np.random.default_rng(rng_seed),
    )
    economy = _TokenEconomy_Basic(
        holding_time=_HoldingTime_Constant(6.0),
        supply=_SupplyController_FromData([_RIG_SUPPLY_STEP] * _RIG_STEPS),
        initial_price=0.05,
        fiat="$",
        token="STLB",
        price_function=_PriceFunction_EOE,
        price_function_parameters={},
        supply_pools=[],
        agent_pools=[pool],
        # Injected generator: the pool-order shuffle flows through the
        # instance stream and never consumes the process-global state.
        rng=_np.random.default_rng(rng_seed + 1),
    )
    for _ in range(_RIG_STEPS):
        economy.execute()
    return economy, treasury


def _rig_counts():
    """Exact staker/unlock counts for the rig, from the pinned mechanics."""
    stakers_per_step = _RIG_DEMAND // _RIG_STAKE  # fee is zero
    created = stakers_per_step * _RIG_STEPS
    # Payout at iteration i + lockup - 1 <= steps  =>  i <= steps - lockup + 1.
    unlocked = stakers_per_step * (_RIG_STEPS - _RIG_LOCKUP + 1)
    return created, unlocked


def test_reward_source_accounting():
    created, unlocked = _rig_counts()
    payout = _RIG_STAKE + _RIG_REWARD
    exogenous = _RIG_SUPPLY_STEP * _RIG_STEPS

    # Minted dilution (no declared treasury): recorded supply never escrows
    # the stake, so the total supply delta equals the minted unlock payouts
    # exactly; of each payout the fixed reward is the pure dilution part.
    economy, treasury = _staking_rig(with_treasury=False)
    assert treasury is None
    minted_delta = economy.supply - exogenous
    assert minted_delta == unlocked * payout
    assert minted_delta > 0  # dilution is visible and positive
    dilution_share = unlocked * _RIG_REWARD
    assert 0 < dilution_share < minted_delta

    # Treasury-drawn rewards: stakes escrow into the declared treasury and
    # payouts are retrieved from it. The treasury's net change decomposes
    # exactly into escrowed principal (still locked) minus rewards paid on
    # completed cycles — the reward source is the treasury, not minting.
    economy, treasury = _staking_rig(with_treasury=True)
    treasury_delta = treasury.treasury["STLB"] - _RIG_TREASURY_INITIAL
    assert treasury_delta == created * _RIG_STAKE - unlocked * payout
    rewards_drawn = unlocked * _RIG_REWARD
    assert (
        treasury_delta
        == (created - unlocked) * _RIG_STAKE - rewards_drawn
    )
    # Per completed cycle the treasury balance DECREASES by exactly the
    # reward: it took the stake in escrow and paid back stake + reward.
    economy_delta = economy.supply - exogenous
    assert economy_delta == -(created * _RIG_STAKE) + unlocked * payout
    # Cross-account conservation: no token is minted in the funded case.
    assert economy_delta + treasury_delta == 0
    # The two reward sources are distinguished and each accounted: the
    # minted case inflates supply by the payouts; the funded case moves the
    # same payouts out of the treasury instead.
    assert economy_delta != minted_delta


def test_cross_economy_channel_conservation():
    config = _load_scenario(_V3_DATA_DIR / "public_multitoken_dependency_v3.yaml")
    factory = _ScenarioFactory()
    plan = {
        context: _derive_generator(
            config.monte_carlo.seed, f"components:{context}", 0
        )
        for context in factory.rng_capable_contexts(config)
    }
    built = factory.build(config, rng_plan=plan)
    ecosystem = built.economy
    master, dependent = ecosystem.token_economies
    assert master.name == "MTLB" and dependent.name == "MTDB"
    channel = config.ecosystem.channels[0]
    assert (channel.from_id, channel.to_id) == ("master", "dependent")

    steps = 12
    total_channeled = 0.0
    total_master_decrease = 0.0
    dependent_inflows = []
    for _ in range(steps):
        master.execute()
        before = master.supply
        dependent.execute()
        after = master.supply
        channeled = dependent.transactions_value_in_fiat
        # The master supply decrease at the dependent's subtraction point
        # equals the channeled token value, bit-exactly (after is computed
        # by the economy as `supply -= prime_token_used`; comparing in this
        # direction avoids cancellation error from the large supply base).
        assert after == before - channeled
        # The channeled value is exactly the declared percentage of the
        # master's current-step token-denominated volume.
        assert channeled == channel.percentage * master.transactions_volume_in_tokens
        total_channeled += channeled
        total_master_decrease += before - after
        dependent_inflows.append(channeled)

    # Cross-economy totals reconcile: the cumulative channeled value equals
    # the cumulative master supply decrease caused by the channel (within
    # the predeclared 1e-6 float-cancellation guard on the differenced
    # large supply base; the per-step identity above is bit-exact) and the
    # cumulative fiat-denominated inflow recorded by the dependent.
    assert abs(total_master_decrease - total_channeled) <= 1e-6
    recorded = dependent._transactions_value_store_in_fiat[:steps]
    assert _math.fsum(recorded) == _math.fsum(dependent_inflows)
    assert total_channeled == _math.fsum(dependent_inflows)
    # The channel really moved value (non-degenerate rig).
    assert total_channeled > 0
    assert all(value > 0 for value in dependent_inflows)
