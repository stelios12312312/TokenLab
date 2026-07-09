import os
import json
import numpy as np
import pandas as pd

METRICS_PATH = "outputs/v2_2026-07-06_120557/pdf_extracted_metrics.json"

def load_extracted_metrics():
    if os.path.exists(METRICS_PATH):
        with open(METRICS_PATH, "r") as f:
            return json.load(f)
    return {
        "total_cumulative_engaged_audience": 1450000000,
        "total_unified_user_ids": 220000000,
        "zee5_registered_users": 180000000,
        "monthly_active_users": 95000000,
        "gold_coin_campaign_cpa_inr": 0.35,
        "zee5_registration_conversion_rate": 0.67
    }

def project_growth(scenario="base", n_epochs=260, custom_params=None):
    metrics = load_extracted_metrics()
    
    # Base parameters calibrated to PDF
    M_potential = metrics["total_cumulative_engaged_audience"]
    CDP_base = metrics["total_unified_user_ids"]
    ZEE5_base = metrics["zee5_registered_users"]
    MAU_base = metrics["monthly_active_users"]
    cpa_inr = metrics["gold_coin_campaign_cpa_inr"]
    conv_rate = metrics["zee5_registration_conversion_rate"]

    epochs = np.arange(1, n_epochs + 1)
    
    # Scenario configuration
    params = {
        "conservative": {"k": 0.02, "p": 0.002, "q": 0.05, "M_scale": 0.5, "retention": 0.85, "spend_pct": 0.15},
        "base":         {"k": 0.04, "p": 0.005, "q": 0.10, "M_scale": 1.0, "retention": 0.90, "spend_pct": 0.25},
        "upside":       {"k": 0.06, "p": 0.010, "q": 0.15, "M_scale": 1.5, "retention": 0.95, "spend_pct": 0.40},
        "stress":       {"k": 0.08, "p": 0.015, "q": 0.20, "M_scale": 1.2, "retention": 0.75, "spend_pct": 0.10},
        "failed_activation": {"k": 0.01, "p": 0.001, "q": 0.02, "M_scale": 0.2, "retention": 0.60, "spend_pct": 0.05}
    }
    
    cfg = params.get(scenario, params["base"]).copy()
    if custom_params:
        cfg.update(custom_params)
    
    # 1. Bass Diffusion & Logistic S-curve for Addressable Audience Growth
    M = M_potential * cfg["M_scale"]
    
    # Bass diffusion solver
    bass_adoptions = np.zeros(n_epochs)
    cum_bass = 0.0
    for t in range(n_epochs):
        new_adopt = (cfg["p"] + cfg["q"] * (cum_bass / M)) * (M - cum_bass)
        new_adopt = max(0.0, new_adopt)
        cum_bass += new_adopt
        bass_adoptions[t] = cum_bass
        
    # Logistic S-curve
    logistic_adoptions = M / (1.0 + np.exp(-cfg["k"] * (epochs - n_epochs // 3)))
    
    # Blended addressable audience
    addressable_audience = 0.5 * bass_adoptions + 0.5 * logistic_adoptions
    
    # 2. Campaign Pulse Growth
    # Pulse triggers representing reality TV seasons (every 52 epochs)
    campaign_pulses = np.zeros(n_epochs)
    for t in range(n_epochs):
        if t % 52 == 12:  # Peak season
            campaign_pulses[t] = 0.10 * M  # Adds 10% of market potential as exposed audience
        elif t % 52 in range(13, 20):  # Decaying tail of season
            campaign_pulses[t] = campaign_pulses[t-1] * 0.8
            
    reachable_audience = addressable_audience + campaign_pulses
    reachable_audience = np.clip(reachable_audience, 0, M_potential * 2.0)
    
    # 3. Funnel conversion
    campaign_exposed = reachable_audience * 0.40
    participants = campaign_exposed * 0.25
    registered = participants * conv_rate
    verified = registered * 0.75
    eligible_acr = verified * 0.80
    
    # 4. Cohort Retention / Monthly Active Users (MAU)
    active_users = np.zeros(n_epochs)
    for t in range(n_epochs):
        new_reg = registered[t] - (registered[t-1] if t > 0 else 0)
        new_reg = max(0.0, new_reg)
        if t == 0:
            active_users[t] = MAU_base
        else:
            active_users[t] = active_users[t-1] * cfg["retention"] + new_reg
            
    # 5. Claimants, Settlers, Utility Spenders, and Stakers
    claimants = eligible_acr * (0.50 if scenario == "stress" else 0.30)
    settlers = claimants * (0.80 if scenario == "stress" else 0.40)
    utility_spenders = active_users * cfg["spend_pct"]
    stakers = active_users * 0.05
    
    df = pd.DataFrame({
        "epoch": epochs,
        "cumulative_addressable_audience": addressable_audience,
        "reachable_audience": reachable_audience,
        "campaign_exposed_users": campaign_exposed,
        "participants": participants,
        "registered_users": registered,
        "verified_profiles": verified,
        "eligible_acr_users": eligible_acr,
        "claimants": claimants,
        "settlers": settlers,
        "monthly_active_users": active_users,
        "utility_spenders": utility_spenders,
        "stakers": stakers
    })
    
    return df
