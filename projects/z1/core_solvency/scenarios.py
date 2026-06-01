import os
import yaml
import copy
from .config import SolvencyConfig

def get_configs_dir():
    return os.path.join(os.path.dirname(__file__), "configs")

def load_yaml(filename):
    path = os.path.join(get_configs_dir(), filename)
    with open(path, "r") as f:
        return yaml.safe_load(f)

def load_m1_scenario(scenario_name: str) -> SolvencyConfig:
    numbers = load_yaml("z1_m1_numbers.yaml")
    scenarios = load_yaml("z1_m1_scenarios.yaml")

    # Find the scenario spec
    spec = None
    if scenario_name == 'm1_cdp_baseline':
        spec = scenarios['m1_cdp_baseline']
    elif scenario_name in scenarios.get('starter_scenarios', {}):
        spec = scenarios['starter_scenarios'][scenario_name]
    else:
        # Check if it's a stable/collapse override variant
        base_name = None
        override = None
        if scenario_name.startswith('stable_'):
            override = scenarios['stable_case_overrides']
            base_name = scenario_name.replace('stable_', '')
        elif scenario_name.startswith('collapse_'):
            override = scenarios['collapse_case_overrides']
            base_name = scenario_name.replace('collapse_', '')
            
        if override:
            # Map base_name to starter_scenarios or m1_cdp_baseline
            if base_name == 'cdp_220m':
                spec = copy.deepcopy(scenarios['m1_cdp_baseline'])
            elif base_name == 'registered_180m':
                spec = copy.deepcopy(scenarios['starter_scenarios']['S1_registered_baseline'])
            elif base_name == 'historical_1050m':
                spec = copy.deepcopy(scenarios['starter_scenarios']['S4_domestic_historical_stress'])
            
            if spec:
                # Apply overrides
                if 'claim_rate' in override: spec['claim_rate'] = override['claim_rate']
                spec['override'] = override

    if spec is None:
        raise ValueError(f"Unknown scenario: {scenario_name}")

    config = SolvencyConfig()

    # Load defaults
    defaults = numbers['m1_default_economics']
    
    config.audience_reserve_initial = defaults['supply']['audience_reserve_initial']
    
    # Check if there is an override, otherwise use defaults
    ovr = spec.get('override', {})
    treasury = ovr.get('treasury', defaults['treasury'])
    config.treasury_initial = treasury['initial_balance']
    config.brand_inflow_per_epoch = treasury['brand_inflow_per_epoch']
    config.treasury_topup_threshold_ratio = defaults['treasury']['topup_threshold_ar_ratio_of_supply']
    config.treasury_topup_target_ratio = defaults['treasury']['topup_target_ar_ratio_of_supply']

    vesting = ovr.get('vesting', defaults['vesting'])
    config.vesting_lag_epochs = vesting['vesting_lag_epochs']

    acr = ovr.get('acr', defaults['acr'])
    config.settlement_ratio = acr.get('settlement_ratio', defaults['acr']['settlement_ratio'])
    config.acr_issue_rate_by_cohort = acr['weekly_acr_issue_rate_per_verified_user']

    settlement = ovr.get('settlement', defaults['settlement'])
    config.settle_propensity_by_cohort = settlement['settlement_propensity_per_epoch']

    utility = ovr.get('utility_spend', defaults['utility_spend'])
    config.utility_spend_rate_by_cohort = utility['spend_rate_per_epoch']
    config.utility_fee_share = utility['utility_fee_share']
    config.utility_burn_share = utility['utility_burn_share']

    throttle = ovr.get('throttle', defaults['throttle'])
    config.throttle_threshold_ratio = throttle.get('throttle_threshold_ar_ratio_of_supply', defaults['throttle']['throttle_threshold_ar_ratio_of_supply'])
    config.throttle_multiplier_when_stressed = throttle.get('throttle_multiplier_when_stressed', defaults['throttle']['throttle_multiplier_when_stressed'])

    # Scenario-specific base settings
    config.initial_viewers = spec['initial_viewers']
    
    # Cohort shares
    cs = spec['cohort_shares']
    if cs == 'behavioral_fallback':
        config.cohort_population_shares = numbers['source_anchors']['cohort_shares_behavioral_fallback']
    elif cs == 'profile_tier_mapping':
        config.cohort_population_shares = numbers['source_anchors']['cohort_shares_from_profile_tiers']
    else:
        config.cohort_population_shares = cs

    # Claim Rate overrides (from starter scenarios or override)
    claim_rate = spec.get('claim_rate', 0.50)
    config.claim_rate_by_cohort = {k: claim_rate for k in config.cohort_population_shares.keys()}
    
    verification_pass_rate = spec.get('verification_pass_rate', 0.94)
    config.verification_pass_rate_by_cohort = {k: verification_pass_rate for k in config.cohort_population_shares.keys()}
    
    config._expected_verified_claimants = spec.get('expected_verified_claimants', spec.get('verified_claimants', 0))

    return config

def get_dev_fast_run_set():
    return [
        'S0_mau_conservative',
        'S1_registered_baseline',
        'S2_cdp_baseline',
        'S3_cdp_high_claim',
        'S4_domestic_historical_stress',
        'S5_full_historical_stress',
        'stable_cdp_220m',
        'collapse_cdp_220m',
        'stable_registered_180m',
        'collapse_registered_180m'
    ]

def get_scenario_config(scenario_name: str) -> SolvencyConfig:
    try:
        return load_m1_scenario(scenario_name)
    except ValueError:
        pass
    except FileNotFoundError:
        pass
    
    config = SolvencyConfig()
    if scenario_name == 'baseline':
        pass
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
    levels = ['low', 'base', 'high']
    scenarios = []
    
    for shock in levels:
        for pressure in levels:
            for support in levels:
                cfg = SolvencyConfig()
                name = f"shock_{shock}_pressure_{pressure}_support_{support}"
                if shock == 'low':
                    cfg.claim_rate_by_cohort = {k: v*0.4 for k,v in cfg.claim_rate_by_cohort.items()}
                elif shock == 'high':
                    cfg.claim_rate_by_cohort = {k: min(1.0, v*2.0) for k,v in cfg.claim_rate_by_cohort.items()}
                if pressure == 'low':
                    cfg.settle_propensity_by_cohort = {k: v*0.4 for k,v in cfg.settle_propensity_by_cohort.items()}
                    cfg.settlement_ratio = 0.25
                elif pressure == 'high':
                    cfg.settle_propensity_by_cohort = {k: min(1.0, v*2.5) for k,v in cfg.settle_propensity_by_cohort.items()}
                    cfg.settlement_ratio = 1.5
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
