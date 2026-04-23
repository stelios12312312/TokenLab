import copy
from .config import SolvencyConfig

def get_scenario_config(scenario_name: str) -> SolvencyConfig:
    config = SolvencyConfig()
    
    if scenario_name == 'baseline':
        pass # use default config
        
    elif scenario_name == 'collapse_case':
        config.claim_rate_by_cohort = {"passive_viewers": 0.4, "active_viewers": 0.8, "power_users": 1.0}
        config.settle_propensity_by_cohort = {"passive_viewers": 0.9, "active_viewers": 0.9, "power_users": 0.9}
        config.settlement_ratio = 1.5
        config.utility_spend_rate_by_cohort = {"passive_viewers": 0.05, "active_viewers": 0.1, "power_users": 0.2}
        config.utility_fee_share = 0.05
        config.brand_inflow_per_epoch = 1_000.0
        
    elif scenario_name == 'stable_case':
        config.claim_rate_by_cohort = {"passive_viewers": 0.05, "active_viewers": 0.15, "power_users": 0.4}
        config.settle_propensity_by_cohort = {"passive_viewers": 0.15, "active_viewers": 0.10, "power_users": 0.05}
        config.settlement_ratio = 0.3
        config.utility_spend_rate_by_cohort = {"passive_viewers": 0.3, "active_viewers": 0.6, "power_users": 0.9}
        config.utility_fee_share = 0.25
        config.brand_inflow_per_epoch = 50_000.0
        
    else:
        raise ValueError(f"Unknown scenario: {scenario_name}")
        
    return config


def generate_stress_grid() -> list[tuple[str, SolvencyConfig]]:
    """
    Generate a 3×3×3 stress grid (27 scenarios) varying:
      - shock (claim rates): low / base / high
      - pressure (settlement): low / base / high
      - support (utility + brand inflow): low / base / high
    
    Rebalanced so that the grid spans collapse → stressed → stable,
    rather than all-collapse.
    """
    levels = ['low', 'base', 'high']
    scenarios = []
    
    for shock in levels:
        for pressure in levels:
            for support in levels:
                cfg = SolvencyConfig()
                name = f"shock_{shock}_pressure_{pressure}_support_{support}"
                
                # ── Migration shock (claim rates) ──
                if shock == 'low':
                    cfg.claim_rate_by_cohort = {k: v*0.4 for k,v in cfg.claim_rate_by_cohort.items()}
                elif shock == 'high':
                    cfg.claim_rate_by_cohort = {k: min(1.0, v*2.0) for k,v in cfg.claim_rate_by_cohort.items()}
                    
                # ── Settlement pressure ──
                if pressure == 'low':
                    cfg.settle_propensity_by_cohort = {k: v*0.4 for k,v in cfg.settle_propensity_by_cohort.items()}
                    cfg.settlement_ratio = 0.25
                elif pressure == 'high':
                    cfg.settle_propensity_by_cohort = {k: min(1.0, v*2.5) for k,v in cfg.settle_propensity_by_cohort.items()}
                    cfg.settlement_ratio = 1.5
                    
                # ── Demand support (utility spend + brand inflow + fee share) ──
                if support == 'low':
                    cfg.utility_spend_rate_by_cohort = {k: v*0.4 for k,v in cfg.utility_spend_rate_by_cohort.items()}
                    cfg.brand_inflow_per_epoch = 2_000.0
                    cfg.utility_fee_share = 0.08
                elif support == 'high':
                    cfg.utility_spend_rate_by_cohort = {k: min(1.0, v*1.8) for k,v in cfg.utility_spend_rate_by_cohort.items()}
                    cfg.brand_inflow_per_epoch = 75_000.0
                    cfg.utility_fee_share = 0.30
                    
                scenarios.append((name, cfg))
                
    return scenarios
