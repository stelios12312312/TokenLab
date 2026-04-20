import copy
from .config import SolvencyConfig

def get_scenario_config(scenario_name: str) -> SolvencyConfig:
    config = SolvencyConfig()
    
    if scenario_name == 'baseline':
        pass # use default config
        
    elif scenario_name == 'collapse_case':
        config.claim_rate_by_cohort = {"passive_viewers": 0.4, "active_viewers": 0.8, "power_users": 1.0}
        config.settle_propensity_by_cohort = {"passive_viewers": 0.9, "active_viewers": 0.9, "power_users": 0.9}
        config.utility_spend_rate_by_cohort = {"passive_viewers": 0.05, "active_viewers": 0.1, "power_users": 0.2}
        config.brand_inflow_per_epoch = 1_000.0
        
    elif scenario_name == 'stable_case':
        config.claim_rate_by_cohort = {"passive_viewers": 0.1, "active_viewers": 0.3, "power_users": 0.6}
        config.settle_propensity_by_cohort = {"passive_viewers": 0.3, "active_viewers": 0.2, "power_users": 0.1}
        config.utility_spend_rate_by_cohort = {"passive_viewers": 0.2, "active_viewers": 0.5, "power_users": 0.9}
        config.brand_inflow_per_epoch = 25_000.0
        
    else:
        raise ValueError(f"Unknown scenario: {scenario_name}")
        
    return config


def generate_stress_grid() -> list[tuple[str, SolvencyConfig]]:
    levels = ['low', 'base', 'high']
    scenarios = []
    
    for shock in levels:
        for pressure in levels:
            for support in levels:
                cfg = SolvencyConfig()
                name = f"shock_{shock}_pressure_{pressure}_support_{support}"
                
                # Migration shock
                if shock == 'low':
                    cfg.claim_rate_by_cohort = {k: v*0.5 for k,v in cfg.claim_rate_by_cohort.items()}
                elif shock == 'high':
                    cfg.claim_rate_by_cohort = {k: min(1.0, v*2.0) for k,v in cfg.claim_rate_by_cohort.items()}
                    
                # Settlement pressure
                if pressure == 'low':
                    cfg.settle_propensity_by_cohort = {k: v*0.5 for k,v in cfg.settle_propensity_by_cohort.items()}
                elif pressure == 'high':
                    cfg.settle_propensity_by_cohort = {k: min(1.0, v*2.0) for k,v in cfg.settle_propensity_by_cohort.items()}
                    cfg.settlement_ratio = 1.5
                    
                # Demand support
                if support == 'low':
                    cfg.utility_spend_rate_by_cohort = {k: v*0.5 for k,v in cfg.utility_spend_rate_by_cohort.items()}
                    cfg.brand_inflow_per_epoch = 1000.0
                elif support == 'high':
                    cfg.utility_spend_rate_by_cohort = {k: min(1.0, v*1.5) for k,v in cfg.utility_spend_rate_by_cohort.items()}
                    cfg.brand_inflow_per_epoch = 50000.0
                    
                scenarios.append((name, cfg))
                
    return scenarios
