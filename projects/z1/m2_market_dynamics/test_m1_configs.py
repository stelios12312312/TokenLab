import pytest
import math
from .scenarios import load_yaml, load_m1_scenario, get_dev_fast_run_set

def test_source_anchors_load():
    numbers = load_yaml("z1_m1_numbers.yaml")
    assert 'source_anchors' in numbers
    anchors = numbers['source_anchors']
    assert anchors['total_z1u_supply_cap'] == 1_000_000_000_000
    assert anchors['audience_reserve']['initial_balance'] == 300_000_000_000
    assert anchors['audience_reserve']['floor_balance'] == 250_000_000_000

def test_cohort_shares_sum_to_one():
    numbers = load_yaml("z1_m1_numbers.yaml")
    for mapping in ['cohort_shares_from_profile_tiers', 'cohort_shares_behavioral_fallback']:
        shares = numbers['source_anchors'][mapping]
        total = sum(shares.values())
        assert math.isclose(total, 1.0, rel_tol=1e-4)

def test_config_constraints():
    numbers = load_yaml("z1_m1_numbers.yaml")
    defaults = numbers['m1_default_economics']
    
    # fee + burn + provider = 1.0
    u_spend = defaults['utility_spend']
    total_share = u_spend['utility_fee_share'] + u_spend['utility_burn_share'] + u_spend['provider_share']
    assert math.isclose(total_share, 1.0, rel_tol=1e-4)
    
    # top-up target > threshold
    treasury = defaults['treasury']
    assert treasury['topup_target_ar_ratio_of_supply'] > treasury['topup_threshold_ar_ratio_of_supply']
    
    # settlement ratio = 1.0
    assert defaults['acr']['settlement_ratio'] == 1.0

def test_s2_cdp_baseline_claimants():
    cfg = load_m1_scenario('S2_cdp_baseline')
    computed_claimants = sum(
        cfg.initial_viewers * cfg.cohort_population_shares[k] * cfg.claim_rate_by_cohort[k] * cfg.verification_pass_rate_by_cohort[k]
        for k in cfg.cohort_population_shares.keys()
    )
    # Expected is roughly 103.4M (220M * 0.5 * 0.94)
    assert math.isclose(computed_claimants, 103_400_000, rel_tol=1e-2)
    
    if hasattr(cfg, '_expected_verified_claimants'):
        assert math.isclose(computed_claimants, cfg._expected_verified_claimants, rel_tol=1e-2)

def test_all_starter_scenarios_instantiate():
    for name in ['S0_mau_conservative', 'S1_registered_baseline', 'S2_cdp_baseline', 
                 'S3_cdp_high_claim', 'S4_domestic_historical_stress', 'S5_full_historical_stress']:
        cfg = load_m1_scenario(name)
        assert cfg.initial_viewers > 0
        for rate in cfg.claim_rate_by_cohort.values():
            assert 0 <= rate <= 1.0

def test_dev_fast_numbers_test_instantiation():
    run_set = get_dev_fast_run_set()
    for name in run_set:
        cfg = load_m1_scenario(name)
        assert cfg.initial_viewers > 0
