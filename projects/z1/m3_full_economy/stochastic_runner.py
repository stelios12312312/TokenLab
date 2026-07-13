# projects/z1/m3_full_economy/stochastic_runner.py
# @planner:module = stochastic_runner
# @planner:story = US-Z1-M3-09

import random
import hashlib
import json
import copy
import numpy as np
import pandas as pd
from typing import Dict, Any, List

from projects.z1.m3_full_economy.config import M3EconomyConfig, COHORT_NAMES
from projects.z1.m3_full_economy.economy import TokenEconomy_Z1
from projects.z1.m3_full_economy.pools import AgentPool_Z1
from projects.z1.m3_full_economy.metrics import extract_epoch_metrics
from projects.z1.m3_full_economy.stochastic_priors import (
    MANUAL_POINT_SHOCK_EPOCH,
    MANUAL_POINT_SHOCK_Z1U,
    apply_stochastic_epoch,
    initialize_stochastic_state,
)

def get_config_hash(config: M3EconomyConfig) -> str:
    # Serialize config variables into a deterministic hash
    config_dict = {}
    for key in sorted(config.__dataclass_fields__.keys()):
        val = getattr(config, key)
        if isinstance(val, dict):
            # Sort dictionary keys
            config_dict[key] = {k: v for k, v in sorted(val.items())}
        else:
            config_dict[key] = str(val)
    config_str = json.dumps(config_dict, sort_keys=True)
    return hashlib.md5(config_str.encode('utf-8')).hexdigest()

def run_single_simulation(
    scenario_id: str,
    run_id: int,
    seed: int,
    base_config: M3EconomyConfig,
    is_stochastic: bool = True,
    inject_point_shock: bool = False
) -> pd.DataFrame:
    # Set deterministic seeds
    np.random.seed(seed)
    random.seed(seed)
    
    # Deep copy the config via instantiation
    config = M3EconomyConfig()
    for key in base_config.__dataclass_fields__.keys():
        setattr(config, key, copy.deepcopy(getattr(base_config, key)))
        
    config_hash = get_config_hash(config)
    
    # Instantiate economy and agent pools
    economy = TokenEconomy_Z1(config)
    for name in COHORT_NAMES + ["creators", "validators"]:
        economy.add_agent_pool(AgentPool_Z1(name, config))
        
    # Save baseline parameters for stochastic jitter / AR(1) referencing
    baseline_deposit = config.campaign_deposit_per_epoch
    baseline_claim_rates = config.claim_rate_by_cohort.copy()
    baseline_panic_threshold = config.panic_price_drop_threshold
    
    stochastic_state = initialize_stochastic_state()
    
    epoch_rows = []
    
    # Run the simulation epoch-by-epoch
    # Note: epoch 0 (initial state) is run during init, but we run 260 steps (1 to 260)
    for epoch in range(1, config.n_epochs + 1):
        if is_stochastic:
            apply_stochastic_epoch(
                config,
                baseline_deposit,
                baseline_claim_rates,
                baseline_panic_threshold,
                stochastic_state,
                rng=np.random,
            )
                
            # 4. Inject manual point sell shock if active (S-PANIC: 1M Z1U sell shock at epoch 40)
            if inject_point_shock and epoch == MANUAL_POINT_SHOCK_EPOCH:
                if not hasattr(economy, 'genesis_unlocked_amounts'):
                    economy.genesis_unlocked_amounts = {}
                economy.genesis_unlocked_amounts['sell_shock'] = economy.genesis_unlocked_amounts.get('sell_shock', 0.0) + MANUAL_POINT_SHOCK_Z1U
                economy.amm.sell_z1u(MANUAL_POINT_SHOCK_Z1U)

                
        economy.execute()
        
    # Extract the metrics history from economy
    df_metrics = economy.get_data()
    
    # Append the run details
    df_metrics.insert(0, "run_id", run_id)
    df_metrics.insert(0, "scenario_id", scenario_id)
    df_metrics.insert(0, "config_hash", config_hash)
    df_metrics.insert(0, "seed", seed)
    
    return df_metrics

def run_scenario(
    scenario_id: str,
    base_config: M3EconomyConfig,
    is_stochastic: bool = True,
    reps: int = 100,
    inject_point_shock: bool = False
) -> pd.DataFrame:
    dfs = []
    for rep in range(reps):
        seed = 10000 + rep
        df_run = run_single_simulation(
            scenario_id=scenario_id,
            run_id=rep,
            seed=seed,
            base_config=base_config,
            is_stochastic=is_stochastic,
            inject_point_shock=inject_point_shock
        )
        dfs.append(df_run)
    return pd.concat(dfs, ignore_index=True)
