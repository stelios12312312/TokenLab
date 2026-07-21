"""M3 public economy class backed by the configured shared implementation."""

import pandas as pd
import random

from TokenLab.simulationcomponents.pricingclasses import PriceFunction_EOE
from TokenLab.simulationcomponents.supplyclasses import SupplyController_Constant
from TokenLab.simulationcomponents.tokeneconomyclasses import TokenEconomy_Basic
from projects.z1.shared_core.economy import ConfiguredZ1Economy
from projects.z1.shared_core.policies import M3_POLICY

from . import ledger
from .amm import AutomatedMarketMaker
from .campaigns import CampaignEngine
from .config import M3EconomyConfig
from .invariants import assert_all_invariants, compute_ar_floor_coverage_ratio, compute_live_supply
from .metrics import extract_epoch_metrics
from .state import initialize_state


class TokenEconomy_Z1(ConfiguredZ1Economy):
    def __init__(self, config: M3EconomyConfig):
        super().__init__(
            config,
            policy=M3_POLICY,
            initialize_state=initialize_state,
            ledger=ledger.LEDGER_API,
            extract_epoch_metrics=extract_epoch_metrics,
            assert_all_invariants=assert_all_invariants,
            compute_live_supply=compute_live_supply,
            compute_ar_floor_coverage_ratio=compute_ar_floor_coverage_ratio,
            amm_cls=AutomatedMarketMaker,
            campaign_cls=CampaignEngine,
        )
