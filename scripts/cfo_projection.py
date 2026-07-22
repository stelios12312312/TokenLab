import os
import pandas as pd
import numpy as np
from scripts.growth_model import project_growth

def run_cfo_projections(scenario="base", n_epochs=260, custom_params=None):
    growth_df = project_growth(scenario, n_epochs, custom_params)
    
    # Financial baseline constants (based on M3 configs)
    initial_ar = 5_000_000.0
    initial_treasury = 2_500_000.0
    settlement_ratio = 0.1047
    utility_fee_share = 0.34
    utility_burn_share = 0.05
    ops_cost = 5000.0
    cip_funding = 10000.0
    vrp_funding = 5000.0
    rwa_yield = 1000.0
    
    # Valuation parameters from PDF
    value_per_profile_inr = 38.36
    cpa_inr = 0.35
    inr_to_usd = 1.0 / 83.0 # Conversion factor
    
    # Projections
    ar_balance = np.zeros(n_epochs)
    treasury_balance = np.zeros(n_epochs)
    settlement_demand = np.zeros(n_epochs)
    utility_spend = np.zeros(n_epochs)
    fee_revenue = np.zeros(n_epochs)
    burn = np.zeros(n_epochs)
    net_cashflow = np.zeros(n_epochs)
    runway_months = np.zeros(n_epochs)
    buyback = np.zeros(n_epochs)
    topup = np.zeros(n_epochs)
    
    # Starting state
    current_ar = initial_ar
    current_treasury = initial_treasury
    
    for t in range(n_epochs):
        # 1. User growth scaling for tokens
        # Convert user base to token economics scale
        scale = 1.0 / 33333.33
        users_claiming = growth_df.loc[t, "claimants"]
        users_settling = growth_df.loc[t, "settlers"]
        users_spending = growth_df.loc[t, "utility_spenders"]
        
        # Token demand/supply flows
        tokens_claimed = users_claiming * scale * 10.0
        tokens_settled = users_settling * scale * settlement_ratio * 100.0
        tokens_spent = users_spending * scale * 2.0
        
        settlement_demand[t] = tokens_settled
        utility_spend[t] = tokens_spent
        
        # Revenues
        fee_revenue[t] = tokens_spent * utility_fee_share
        burn[t] = tokens_spent * utility_burn_share
        
        # Net Cashflow
        net_cashflow[t] = fee_revenue[t] + rwa_yield - ops_cost - cip_funding - vrp_funding
        
        # Balance sheet update
        current_ar -= tokens_settled
        
        # Top-up logic (Audience Reserve to Treasury, or vice versa if stressed)
        topup_needed = 0.0
        if current_treasury < initial_treasury * 0.3:
            topup_needed = min(current_ar * 0.05, initial_treasury * 0.4 - current_treasury)
            current_ar -= topup_needed
            current_treasury += topup_needed
            
        topup[t] = topup_needed
        current_treasury += net_cashflow[t]
        
        # Buyback defense peg if treasury is in surplus
        if current_treasury > initial_treasury * 1.5:
            surplus = current_treasury - initial_treasury
            buyback_amt = surplus * 0.10
            current_treasury -= buyback_amt
            buyback[t] = buyback_amt
            
        # Solvency floor safety
        current_ar = max(0.0, current_ar)
        current_treasury = max(0.0, current_treasury)
        
        ar_balance[t] = current_ar
        treasury_balance[t] = current_treasury
        
        # Runway (months) = Treasury / (Ops Cost + Pools) * (30/7) to convert epochs to months
        runway_months[t] = (current_treasury / (ops_cost + cip_funding + vrp_funding)) * 4.33
        
    growth_df["audience_reserve_health"] = ar_balance
    growth_df["treasury_health"] = treasury_balance
    growth_df["settlement_demand"] = settlement_demand
    growth_df["utility_spend"] = utility_spend
    growth_df["treasury_fee_revenue"] = fee_revenue
    growth_df["burn"] = burn
    growth_df["net_protocol_cashflow"] = net_cashflow
    growth_df["treasury_runway_months"] = runway_months
    growth_df["buyback_requirement"] = buyback
    growth_df["required_topup"] = topup
    
    # CDP valuation (in USD)
    growth_df["data_asset_value"] = growth_df["verified_profiles"] * value_per_profile_inr * inr_to_usd
    
    # Implied Unit Economics
    growth_df["cac_usd"] = cpa_inr * inr_to_usd
    # Lifetime Value is cumulative utility spend contribution per active user
    growth_df["ltv_usd"] = (growth_df["utility_spend"] * utility_fee_share / (growth_df["monthly_active_users"] + 1)) * 52.0
    growth_df["ltv_to_cac"] = growth_df["ltv_usd"] / (growth_df["cac_usd"] + 1e-6)
    
    return growth_df
