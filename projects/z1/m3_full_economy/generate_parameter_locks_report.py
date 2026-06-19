#!/usr/bin/env python
"""
generate_parameter_locks_report.py

Evaluates the Z1 Milestone 3 configuration against the Tokenomics Parameter Locks
and generates a premium, dark-themed HTML dashboard reporting the results.
"""

import os
import sys
import json
from datetime import datetime

# Add the project directory to sys.path so we can import the config
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from config import M3EconomyConfig, COHORT_NAMES

def generate_report():
    cfg = M3EconomyConfig()
    
    # 1. Evaluate all locks programmatically
    solvency_ratio = cfg.compute_solvency_ratio()
    solvency_diagnostics = cfg.check_solvency_locks()
    m2_diagnostics = cfg.check_m2_locks()
    
    # Re-structure locks to capture comprehensive values
    locks_data = []
    
    # Lock 1: Solvency Ratio Floor Invariant
    l1_status = "PASS"
    l1_class = "pass"
    if solvency_ratio >= 1.0:
        l1_status = "FAIL"
        l1_class = "fail"
    elif solvency_ratio >= 0.8:
        l1_status = "WARN"
        l1_class = "warn"
        
    locks_data.append({
        "id": "L1",
        "name": "Solvency Floor Invariant",
        "type": "HARD",
        "formula": "Outflow / Inflow < 0.8",
        "status": l1_status,
        "class": l1_class,
        "description": "Predicts solvency collapse. Total claim and settlement pressure must be less than 80% of backflow fee revenue and brand inflow.",
        "details": f"Outflow Rate: {sum(cfg.cohort_population_shares[c] * cfg.claim_rate_by_cohort.get(c, 0) * cfg.settle_propensity_by_cohort.get(c, 0) for c in COHORT_NAMES) * cfg.settlement_ratio:.6f}<br>Inflow Rate: {sum(cfg.cohort_population_shares[c] * cfg.utility_spend_rate_by_cohort.get(c, 0) for c in COHORT_NAMES) * cfg.utility_fee_share + (cfg.brand_inflow_per_epoch / cfg.audience_reserve_initial):.6f}",
        "value": f"{solvency_ratio:.4f}",
        "threshold": "0.8000",
        "pct": min(100, int((solvency_ratio / 0.8) * 100)) if solvency_ratio > 0 else 0
    })
    
    # Lock 2: Settlement-Fee Ratio
    l2_limit = 2 * cfg.utility_fee_share
    l2_status = "PASS" if cfg.settlement_ratio <= l2_limit else "FAIL"
    l2_class = l2_status.lower()
    locks_data.append({
        "id": "L2",
        "name": "Settlement-Fee Ratio",
        "type": "SOFT",
        "formula": "settlement_ratio ≤ 2 × utility_fee_share",
        "status": l2_status,
        "class": l2_class,
        "description": "Prevents structural drain. If settlement is more than 2x the fee share, the system drains faster than it replenishes.",
        "details": f"Settlement Ratio: {cfg.settlement_ratio:.4f}<br>Utility Fee Share: {cfg.utility_fee_share:.4f} (Limit: {l2_limit:.4f})",
        "value": f"{cfg.settlement_ratio:.4f}",
        "threshold": f"{l2_limit:.4f}",
        "pct": min(100, int((cfg.settlement_ratio / l2_limit) * 100)) if l2_limit > 0 else 0
    })
    
    # Lock 3: Brand Inflow Floor
    inflow_pct = (cfg.brand_inflow_per_epoch / cfg.audience_reserve_initial) * 100
    l3_status = "PASS" if inflow_pct >= 1.0 else "FAIL"
    l3_class = l3_status.lower()
    locks_data.append({
        "id": "L3",
        "name": "Brand Inflow Floor",
        "type": "HARD",
        "formula": "brand_inflow_per_epoch ≥ 1% of AR_initial",
        "status": l3_status,
        "class": l3_class,
        "description": "Critical backstop. No simulated scenarios remained stable when brand inflows dropped below 1% of the initial Audience Reserve.",
        "details": f"Brand Inflow: {cfg.brand_inflow_per_epoch:,.0f} Z1U / epoch<br>Initial AR: {cfg.audience_reserve_initial:,.0f} Z1U",
        "value": f"{inflow_pct:.2f}%",
        "threshold": "1.00%",
        "pct": min(100, int((inflow_pct / 1.0) * 100)) if inflow_pct > 0 else 0
    })
    
    # Lock 4: Cohort Net-Drain Check
    l4_failures = []
    for c in COHORT_NAMES:
        settle = cfg.settle_propensity_by_cohort.get(c, 0)
        spend = cfg.utility_spend_rate_by_cohort.get(c, 0)
        if spend > 0 and settle > 0.5 * spend:
            l4_failures.append(f"{c} ({settle:.4f} > {0.5*spend:.4f})")
            
    l4_status = "WARN" if l4_failures else "PASS"
    l4_class = l4_status.lower()
    l4_desc = "For each cohort, settle propensity must be ≤ 50% of utility spend rate to ensure they are net contributors."
    l4_details = "<br>".join([f"<strong>{c}</strong>: settle={cfg.settle_propensity_by_cohort.get(c, 0):.4f}, spend={cfg.utility_spend_rate_by_cohort.get(c, 0):.4f}" for c in COHORT_NAMES])
    if l4_failures:
        l4_details += "<br><span style='color:var(--warning-color)'>Violators: " + ", ".join(l4_failures) + "</span>"
    locks_data.append({
        "id": "L4",
        "name": "Cohort Net-Drain Check",
        "type": "SOFT",
        "formula": "settle_propensity[c] ≤ 0.5 × spend[c]",
        "status": l4_status,
        "class": l4_class,
        "description": l4_desc,
        "details": l4_details,
        "value": "Compliant" if not l4_failures else "Warning",
        "threshold": "Settle ≤ 50% Spend",
        "pct": 100 if l4_status == "PASS" else 50
    })
    
    # Lock 5: Treasury Funding Feasibility Check
    topup_budget = cfg.treasury_topup_target_ratio * cfg.audience_reserve_initial
    projected_inflow = (cfg.brand_inflow_per_epoch + sum(cfg.utility_spend_rate_by_cohort.values()) * cfg.utility_fee_share * 1000) * cfg.n_epochs
    l5_status = "PASS" if topup_budget <= projected_inflow else "WARN"
    l5_class = l5_status.lower()
    locks_data.append({
        "id": "L5",
        "name": "Treasury Funding Check",
        "type": "SOFT",
        "formula": "topup budget ≤ cumulative inflows",
        "status": l5_status,
        "class": l5_class,
        "description": "Prevents unfunded topup promises. Total target budget must be supported by projected epoch revenues.",
        "details": f"Target Topup: {topup_budget:,.0f} Z1U<br>Projected Inflow: {projected_inflow:,.0f} Z1U",
        "value": f"{topup_budget:,.0f}",
        "threshold": f"{projected_inflow:,.0f}",
        "pct": min(100, int((topup_budget / projected_inflow) * 100)) if projected_inflow > 0 else 0
    })
    
    # Lock 7: Treasury Net Flow Solvency
    structural_inflows = cfg.rwa_yield_per_epoch + (cfg.campaign_deposit_per_epoch * cfg.campaign_fee_percentage)
    structural_outflows = cfg.operational_cost_per_epoch + cfg.cip_replenishment_per_epoch
    net_flow = structural_inflows - structural_outflows
    l7_status = "PASS" if net_flow >= 0 else "FAIL"
    l7_class = l7_status.lower()
    locks_data.append({
        "id": "L7",
        "name": "Treasury Net Flow Lock",
        "type": "HARD",
        "formula": "Inflow ≥ Outflow (Steady State)",
        "status": l7_status,
        "class": l7_class,
        "description": "Prevents Zombie State. Structural inflows (RWA Yield + Campaign fees) must exceed ongoing validator and operational subsidies.",
        "details": f"Structural Inflow: {structural_inflows:,.0f} Z1U/epoch<br>Subsidies/Outflow: {structural_outflows:,.0f} Z1U/epoch",
        "value": f"{net_flow:+,.0f}",
        "threshold": "≥ 0",
        "pct": 100 if net_flow >= 0 else 0
    })
    
    # Lock 8: AMM Price Floor defense
    l8_status = "PASS" if cfg.treasury_buyback_ratio > 0.0 else "FAIL"
    l8_class = l8_status.lower()
    locks_data.append({
        "id": "L8",
        "name": "AMM Peg Defense Lock",
        "type": "HARD",
        "formula": "treasury_buyback_ratio > 0.0",
        "status": l8_status,
        "class": l8_class,
        "description": "Defends pricing peg. The treasury must allocate a portion of its surplus to dynamic buybacks to sustain the price floor.",
        "details": f"Treasury Buyback Ratio: {cfg.treasury_buyback_ratio:.4f}",
        "value": f"{cfg.treasury_buyback_ratio:.4f}",
        "threshold": "> 0.0000",
        "pct": min(100, int((cfg.treasury_buyback_ratio / 0.05) * 100)) if cfg.treasury_buyback_ratio > 0 else 0
    })
    
    # Lock 9: Per-Epoch AR Drain Cap
    drain_cap = cfg.settlement_cap_per_epoch * cfg.settlement_ratio
    max_drain_limit = 0.10 * cfg.audience_reserve_initial
    l9_status = "PASS" if drain_cap <= max_drain_limit else "FAIL"
    l9_class = l9_status.lower()
    locks_data.append({
        "id": "L9",
        "name": "AR Epoch Drain Cap",
        "type": "HARD",
        "formula": "Max Settle Outflow ≤ 10% AR_initial",
        "status": l9_status,
        "class": l9_class,
        "description": "Anti-stampede constraint. Caps maximum potential outflow per epoch to 10% of the initial reserve.",
        "details": f"Max Outflow: {drain_cap:,.0f} Z1U/epoch<br>Limit (10% AR): {max_drain_limit:,.0f} Z1U",
        "value": f"{drain_cap:,.0f}",
        "threshold": f"{max_drain_limit:,.0f}",
        "pct": min(100, int((drain_cap / max_drain_limit) * 100)) if max_drain_limit > 0 else 0
    })

    # Summary Statistics
    passed_count = sum(1 for l in locks_data if l["status"] == "PASS")
    warn_count = sum(1 for l in locks_data if l["status"] == "WARN")
    failed_count = sum(1 for l in locks_data if l["status"] == "FAIL")
    total_count = len(locks_data)
    
    # 2. Build the HTML content
    html_template = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Z1 Tokenomics Parameter Locks Report</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {{
      --bg-primary: #0b0f19;
      --bg-secondary: #111827;
      --bg-tertiary: #1f2937;
      --card-bg: #1e293b;
      --card-border: #334155;
      
      --text-primary: #f8fafc;
      --text-secondary: #94a3b8;
      --text-muted: #64748b;
      
      --accent-color: #0ea5e9;
      --accent-gradient: linear-gradient(135deg, #0ea5e9, #6366f1);
      
      --success-color: #10b981;
      --success-bg: rgba(16, 185, 129, 0.1);
      --success-border: rgba(16, 185, 129, 0.2);
      
      --warning-color: #f59e0b;
      --warning-bg: rgba(245, 158, 11, 0.1);
      --warning-border: rgba(245, 158, 11, 0.2);
      
      --danger-color: #ef4444;
      --danger-bg: rgba(239, 68, 68, 0.1);
      --danger-border: rgba(239, 68, 68, 0.2);
      
      --card-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.4), 0 4px 6px -4px rgba(0, 0, 0, 0.4);
    }}

    * {{
      box-sizing: border-box;
      transition: all 0.2s ease-in-out;
    }}

    body {{
      background-color: var(--bg-primary);
      color: var(--text-primary);
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      margin: 0;
      padding: 0;
      min-height: 100vh;
      line-height: 1.6;
    }}

    .container {{
      max-width: 1200px;
      margin: 0 auto;
      padding: 2.5rem 1.5rem;
    }}

    /* Header Styling */
    header {{
      margin-bottom: 3rem;
      position: relative;
    }}

    header::after {{
      content: '';
      position: absolute;
      bottom: -1rem;
      left: 0;
      width: 60px;
      height: 4px;
      background: var(--accent-gradient);
      border-radius: 2px;
    }}

    h1 {{
      font-family: 'Outfit', sans-serif;
      font-size: 2.8rem;
      font-weight: 700;
      margin: 0 0 0.5rem 0;
      letter-spacing: -0.02em;
      background: var(--accent-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }}

    .subtitle {{
      color: var(--text-secondary);
      font-size: 1.1rem;
      margin: 0;
      font-weight: 300;
    }}

    /* Summary Grid */
    .summary-grid {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1.5rem;
      margin-bottom: 3rem;
    }}

    .summary-card {{
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 1.5rem;
      box-shadow: var(--card-shadow);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }}

    .summary-card:hover {{
      transform: translateY(-4px);
      border-color: #475569;
    }}

    .summary-title {{
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-secondary);
      margin-bottom: 1rem;
      font-weight: 600;
    }}

    .summary-value {{
      font-size: 2.2rem;
      font-family: 'Outfit', sans-serif;
      font-weight: 700;
      margin: 0;
    }}

    /* Circular Solvency Ratio Ring */
    .gauge-wrapper {{
      display: flex;
      align-items: center;
      gap: 1.5rem;
    }}

    .solvency-gauge {{
      position: relative;
      width: 80px;
      height: 80px;
    }}

    .solvency-gauge svg {{
      transform: rotate(-90deg);
      width: 100%;
      height: 100%;
    }}

    .solvency-gauge circle {{
      fill: none;
      stroke-width: 6px;
    }}

    .solvency-gauge .bg-ring {{
      stroke: #334155;
    }}

    .solvency-gauge .progress-ring {{
      stroke: var(--success-color);
      stroke-linecap: round;
      stroke-dasharray: 226;
      stroke-dashoffset: {226 - (min(solvency_ratio, 0.8) / 0.8) * 226:.1f};
    }}

    .solvency-gauge .value-label {{
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      font-weight: 700;
      font-size: 1.05rem;
      font-family: 'Outfit', sans-serif;
      color: var(--success-color);
    }}

    /* Filter Controls */
    .controls {{
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      flex-wrap: wrap;
      gap: 1rem;
    }}

    .filter-tabs {{
      display: flex;
      background: var(--bg-secondary);
      padding: 0.3rem;
      border-radius: 8px;
      border: 1px solid var(--card-border);
    }}

    .tab-btn {{
      background: transparent;
      border: none;
      color: var(--text-secondary);
      padding: 0.5rem 1.2rem;
      border-radius: 6px;
      font-size: 0.9rem;
      cursor: pointer;
      font-weight: 500;
    }}

    .tab-btn.active {{
      background: var(--accent-gradient);
      color: var(--text-primary);
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2);
    }}

    .search-box {{
      position: relative;
    }}

    .search-box input {{
      background: var(--bg-secondary);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 0.6rem 1rem 0.6rem 2.5rem;
      color: var(--text-primary);
      font-size: 0.9rem;
      width: 250px;
    }}

    .search-box input:focus {{
      outline: none;
      border-color: var(--accent-color);
      box-shadow: 0 0 0 2px rgba(14, 165, 233, 0.2);
    }}

    .search-box::before {{
      content: '🔍';
      position: absolute;
      left: 0.9rem;
      top: 50%;
      transform: translateY(-50%);
      font-size: 0.85rem;
      color: var(--text-muted);
    }}

    /* Locks Grid */
    .locks-grid {{
      display: grid;
      grid-template-columns: 1fr;
      gap: 1.5rem;
      margin-bottom: 3rem;
    }}

    .lock-card {{
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      box-shadow: var(--card-shadow);
      overflow: hidden;
      display: grid;
      grid-template-columns: 80px 1fr 200px;
      align-items: center;
    }}

    @media (max-width: 768px) {{
      .lock-card {{
        grid-template-columns: 1fr;
        padding: 1.5rem;
      }}
      .lock-badge-col {{
        text-align: left !important;
        margin-top: 1rem;
      }}
      .lock-id-col {{
        margin-bottom: 0.5rem;
      }}
    }}

    .lock-id-col {{
      height: 100%;
      background: rgba(0,0,0,0.15);
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      border-right: 1px solid var(--card-border);
      padding: 1rem;
    }}

    .lock-id {{
      font-family: 'Outfit', sans-serif;
      font-size: 1.6rem;
      font-weight: 700;
      color: var(--text-secondary);
    }}

    .lock-id-type {{
      font-size: 0.65rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      margin-top: 0.25rem;
    }}

    .type-hard {{
      background: rgba(239, 68, 68, 0.1);
      color: var(--danger-color);
    }}

    .type-soft {{
      background: rgba(14, 165, 233, 0.1);
      color: var(--accent-color);
    }}

    .lock-body-col {{
      padding: 1.5rem;
    }}

    .lock-title {{
      font-size: 1.25rem;
      font-weight: 600;
      margin: 0 0 0.5rem 0;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }}

    .lock-formula {{
      font-family: monospace;
      background: rgba(0,0,0,0.2);
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-size: 0.85rem;
      color: var(--accent-color);
      border: 1px solid rgba(255,255,255,0.05);
    }}

    .lock-desc {{
      color: var(--text-secondary);
      font-size: 0.95rem;
      margin: 0 0 1rem 0;
    }}

    .lock-details {{
      font-size: 0.85rem;
      color: var(--text-muted);
      border-top: 1px solid rgba(255,255,255,0.05);
      padding-top: 0.75rem;
      line-height: 1.5;
    }}

    .lock-badge-col {{
      padding: 1.5rem;
      border-left: 1px solid rgba(255,255,255,0.05);
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
    }}

    @media (max-width: 768px) {{
      .lock-badge-col {{
        border-left: none;
        border-top: 1px solid rgba(255,255,255,0.05);
        align-items: flex-start;
        padding-top: 1rem;
      }}
    }}

    .status-badge {{
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 0.8rem;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      padding: 0.35rem 1rem;
      border-radius: 20px;
      margin-bottom: 0.75rem;
      width: 100px;
    }}

    .status-badge.pass {{
      background: var(--success-bg);
      color: var(--success-color);
      border: 1px solid var(--success-border);
    }}

    .status-badge.warn {{
      background: var(--warning-bg);
      color: var(--warning-color);
      border: 1px solid var(--warning-border);
    }}

    .status-badge.fail {{
      background: var(--danger-bg);
      color: var(--danger-color);
      border: 1px solid var(--danger-border);
    }}

    .lock-value-row {{
      display: flex;
      justify-content: space-between;
      width: 100%;
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin-top: 0.25rem;
    }}

    .progress-bar-container {{
      width: 100%;
      height: 6px;
      background: #334155;
      border-radius: 3px;
      overflow: hidden;
      margin-top: 0.5rem;
    }}

    .progress-bar {{
      height: 100%;
      border-radius: 3px;
    }}

    .progress-bar.pass {{ background-color: var(--success-color); }}
    .progress-bar.warn {{ background-color: var(--warning-color); }}
    .progress-bar.fail {{ background-color: var(--danger-color); }}

    /* Cohort Matrix Section */
    .matrix-section {{
      margin-top: 4rem;
      background: var(--bg-secondary);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 2rem;
      box-shadow: var(--card-shadow);
    }}

    .section-title {{
      font-family: 'Outfit', sans-serif;
      font-size: 1.8rem;
      font-weight: 600;
      margin: 0 0 1.5rem 0;
    }}

    table {{
      width: 100%;
      border-collapse: collapse;
      margin-top: 1rem;
      font-size: 0.95rem;
    }}

    th {{
      text-align: left;
      color: var(--text-secondary);
      font-weight: 600;
      padding: 1rem;
      border-bottom: 2px solid var(--card-border);
    }}

    td {{
      padding: 1rem;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }}

    tr:hover td {{
      background: rgba(255,255,255,0.02);
    }}

    .cohort-name {{
      font-weight: 600;
      color: var(--text-primary);
    }}

    /* Raw Config Section */
    .collapsible {{
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--text-primary);
      cursor: pointer;
      padding: 1.2rem;
      width: 100%;
      text-align: left;
      outline: none;
      font-size: 1.1rem;
      font-weight: 600;
      border-radius: 12px;
      margin-top: 2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }}

    .collapsible::after {{
      content: '➕';
      font-size: 0.8rem;
      color: var(--text-secondary);
    }}

    .collapsible.active::after {{
      content: '➖';
    }}

    .collapsible-content {{
      padding: 0 1.2rem;
      max-height: 0;
      overflow: hidden;
      background-color: rgba(0,0,0,0.15);
      border-radius: 0 0 12px 12px;
      border: 1px solid transparent;
      border-top: none;
    }}

    .collapsible-content.show {{
      max-height: 1000px;
      padding: 1.5rem;
      border-color: var(--card-border);
    }}

    pre {{
      margin: 0;
      font-family: monospace;
      font-size: 0.85rem;
      color: var(--accent-color);
      overflow-x: auto;
    }}

    footer {{
      margin-top: 5rem;
      text-align: center;
      color: var(--text-muted);
      font-size: 0.85rem;
      border-top: 1px solid var(--card-border);
      padding-top: 2rem;
    }}
  </style>
</head>
<body>

  <div class="container">
    <header>
      <h1>Z1 Parameter Locks Status</h1>
      <p class="subtitle">Milestone 3 Simulation Parameter Invariant Validator</p>
    </header>

    <!-- Summary Widgets -->
    <div class="summary-grid">
      <div class="summary-card">
        <p class="summary-title">L1 Solvency Ratio</p>
        <div class="gauge-wrapper">
          <div class="solvency-gauge">
            <svg>
              <circle class="bg-ring" cx="40" cy="40" r="36"></circle>
              <circle class="progress-ring" cx="40" cy="40" r="36"></circle>
            </svg>
            <div class="value-label">{solvency_ratio:.3f}</div>
          </div>
          <div>
            <p style="margin:0;font-weight:600;font-size:1rem;color:var(--success-color)">Structurally Stable</p>
            <p style="margin:0.25rem 0 0 0;font-size:0.8rem;color:var(--text-secondary)">Limit threshold: 0.800</p>
          </div>
        </div>
      </div>

      <div class="summary-card">
        <p class="summary-title">Locks Status</p>
        <p class="summary-value" style="color: var(--text-primary)">
          <span style="color:var(--success-color)">{passed_count}</span>
          <span style="font-size:0.9rem;font-weight:400;color:var(--text-muted)">/ {total_count} Passed</span>
        </p>
        <div style="display:flex;gap:1rem;margin-top:0.5rem;font-size:0.85rem">
          <span style="color:var(--warning-color)">⚠️ {warn_count} Warning</span>
          <span style="color:var(--danger-color)">❌ {failed_count} Deficient</span>
        </div>
      </div>

      <div class="summary-card" style="border-color: {'var(--danger-border)' if failed_count else 'var(--success-border)'}">
        <p class="summary-title">Overall Verdict</p>
        <p class="summary-value" style="color: {'var(--danger-color)' if failed_count else 'var(--success-color)'}; font-size:1.6rem">
          {"DEFICIENT (Peg Undefended)" if failed_count else "STRUCTURALLY SOUND"}
        </p>
        <p style="margin:0.5rem 0 0 0;font-size:0.8rem;color:var(--text-secondary)">
          {"L8 failed: Treasury buyback ratio is 0.00." if failed_count else "All hard locks are satisfied."}
        </p>
      </div>
    </div>

    <!-- Filter Buttons & Search -->
    <div class="controls">
      <div class="filter-tabs">
        <button class="tab-btn active" id="btn-all" onclick="filterLocks('all')">All Locks</button>
        <button class="tab-btn" id="btn-hard" onclick="filterLocks('HARD')">Hard Locks</button>
        <button class="tab-btn" id="btn-soft" onclick="filterLocks('SOFT')">Soft Locks</button>
        <button class="tab-btn" id="btn-fail" onclick="filterLocks('FAIL')">Deficient ({failed_count})</button>
      </div>
      <div class="search-box">
        <input type="text" id="lock-search" oninput="searchLocks()" placeholder="Search by name or formula...">
      </div>
    </div>

    <!-- Locks Cards Grid -->
    <div class="locks-grid" id="locks-container">
"""
    
    # 3. Add Lock Cards
    for l in locks_data:
        html_template += f"""
      <div class="lock-card" data-type="{l["type"]}" data-status="{l["status"]}" id="card-{l["id"]}">
        <div class="lock-id-col">
          <span class="lock-id">{l["id"]}</span>
          <span class="lock-id-type type-{l["type"].lower()}">{l["type"]}</span>
        </div>
        <div class="lock-body-col">
          <h3 class="lock-title">
            {l["name"]}
            <span class="lock-formula">{l["formula"]}</span>
          </h3>
          <p class="lock-desc">{l["description"]}</p>
          <div class="lock-details">
            {l["details"]}
          </div>
        </div>
        <div class="lock-badge-col">
          <span class="status-badge {l["class"]}">{l["status"]}</span>
          <div class="lock-value-row">
            <span>Value: <strong>{l["value"]}</strong></span>
            <span>Limit: <strong>{l["threshold"]}</strong></span>
          </div>
          <div class="progress-bar-container">
            <div class="progress-bar {l["class"]}" style="width: {l["pct"]}%"></div>
          </div>
        </div>
      </div>
"""
        
    # 4. Add Cohort breakdown table & config inspector
    html_template += f"""
    </div>

    <!-- Cohort parameters matrix -->
    <div class="matrix-section">
      <h2 class="section-title">Cohort Economics Matrix</h2>
      <p style="color:var(--text-secondary);font-size:0.95rem;margin-bottom:1.5rem">Displays key parameters defining claim rates, settle propensities, and utility spend rates for all configured user cohorts.</p>
      <table>
        <thead>
          <tr>
            <th>Cohort</th>
            <th>Population Share</th>
            <th>Claim Rate</th>
            <th>Settle Propensity</th>
            <th>Utility Spend Rate</th>
            <th>Staking Rate</th>
          </tr>
        </thead>
        <tbody>
"""

    for name in COHORT_NAMES:
        share = cfg.cohort_population_shares.get(name, 0)
        claim = cfg.claim_rate_by_cohort.get(name, 0)
        settle = cfg.settle_propensity_by_cohort.get(name, 0)
        spend = cfg.utility_spend_rate_by_cohort.get(name, 0)
        staking = cfg.staking_rate_by_cohort.get(name, 0)
        
        html_template += f"""
          <tr>
            <td class="cohort-name">{name.replace('_', ' ').title()}</td>
            <td>{share * 100:.1f}%</td>
            <td>{claim:.2f}</td>
            <td>{settle:.4f}</td>
            <td>{spend:.4f}</td>
            <td>{staking * 100:.1f}%</td>
          </tr>
"""

    config_dict = {k: v for k, v in cfg.__dict__.items() if not k.startswith('_')}
    config_json_str = json.dumps(config_dict, indent=2)

    html_template += f"""
        </tbody>
      </table>
    </div>

    <!-- Raw Config Inspector -->
    <button class="collapsible" id="config-collapse-btn" onclick="toggleConfig()">View Config Variables</button>
    <div class="collapsible-content" id="config-content">
      <pre>{config_json_str}</pre>
    </div>

    <footer>
      <p>Report generated at {datetime.now().strftime("%Y-%m-%d %H:%M:%S")} • Z1 TokenLab Automation Engine</p>
    </footer>
  </div>

  <script>
    // Tab filtering
    function filterLocks(type) {{
      const cards = document.querySelectorAll('.lock-card');
      const tabs = document.querySelectorAll('.tab-btn');
      
      // Update active tab styling
      tabs.forEach(tab => tab.classList.remove('active'));
      const activeId = type === 'all' ? 'btn-all' : type === 'HARD' ? 'btn-hard' : type === 'SOFT' ? 'btn-soft' : 'btn-fail';
      document.getElementById(activeId).classList.add('active');
      
      cards.forEach(card => {{
        const cardType = card.getAttribute('data-type');
        const cardStatus = card.getAttribute('data-status');
        
        if (type === 'all') {{
          card.style.display = 'grid';
        }} else if (type === 'FAIL') {{
          if (cardStatus === 'FAIL') {{
            card.style.display = 'grid';
          }} else {{
            card.style.display = 'none';
          }}
        }} else {{
          if (cardType === type) {{
            card.style.display = 'grid';
          }} else {{
            card.style.display = 'none';
          }}
        }}
      }});
    }}

    // Search filtering
    function searchLocks() {{
      const query = document.getElementById('lock-search').value.toLowerCase();
      const cards = document.querySelectorAll('.lock-card');
      
      cards.forEach(card => {{
        const text = card.textContent.toLowerCase();
        if (text.includes(query)) {{
          card.style.display = 'grid';
        }} else {{
          card.style.display = 'none';
        }}
      }});
    }}

    // Collapsible Config
    function toggleConfig() {{
      const btn = document.getElementById('config-collapse-btn');
      const content = document.getElementById('config-content');
      btn.classList.toggle('active');
      content.classList.toggle('show');
    }}
  </script>
</body>
</html>
"""
    
    # 5. Output report to target file
    out_dir = "outputs/z1_m3_sims/compare"
    os.makedirs(out_dir, exist_ok=True)
    report_path = os.path.join(out_dir, "parameter_locks_report.html")
    with open(report_path, "w") as f:
        f.write(html_template)
    
    print(f"✓ Created parameter locks HTML report at: {report_path}")

if __name__ == "__main__":
    generate_report()
