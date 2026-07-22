"""M2 public economy class backed by the configured shared implementation."""

import pandas as pd
import random

from TokenLab.simulationcomponents.pricingclasses import PriceFunction_EOE
from TokenLab.simulationcomponents.supplyclasses import SupplyController_Constant
from TokenLab.simulationcomponents.tokeneconomyclasses import TokenEconomy_Basic
from projects.z1.shared_core.economy import ConfiguredZ1Economy
from projects.z1.shared_core.policies import M2_POLICY

from . import ledger
from .amm import AutomatedMarketMaker
from .campaigns import CampaignEngine
from .config import SolvencyConfig
from .invariants import assert_all_invariants
from .metrics import extract_epoch_metrics
from .state import initialize_state


class TokenEconomy_Z1(ConfiguredZ1Economy):
    def __init__(self, config: SolvencyConfig):
        super().__init__(
            config,
            policy=M2_POLICY,
            initialize_state=initialize_state,
            ledger=ledger.LEDGER_API,
            extract_epoch_metrics=extract_epoch_metrics,
            assert_all_invariants=assert_all_invariants,
            amm_cls=AutomatedMarketMaker,
            campaign_cls=CampaignEngine,
        )
