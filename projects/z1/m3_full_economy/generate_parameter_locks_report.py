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
from pathlib import Path

# Keep both package imports and historical direct-script execution working.
REPO = Path(__file__).resolve().parents[3]
for import_root in (REPO, Path(__file__).resolve().parent):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))

try:
    from .parameter_locks_data import COHORT_NAMES, build_parameter_locks_data
except ImportError:  # Direct-script compatibility
    from parameter_locks_data import COHORT_NAMES, build_parameter_locks_data

def generate_report():
    data = build_parameter_locks_data()
    cfg = data.config
    parity_results = data.parity_results
    solvency_ratio = data.solvency_ratio
    locks_data = list(data.locks)
    passed_count = data.passed_count
    warn_count = data.warn_count
    failed_count = data.failed_count
    total_count = data.total_count

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
        
    # 4. Add Simulation Scale & Cohort Assumptions section
    html_template += f"""
    </div>

    <!-- Simulation Scale & Cohort Assumptions -->
    <div class="matrix-section">
      <h2 class="section-title">Simulation Scale & Cohort Assumptions</h2>
      <p style="color:var(--text-secondary);font-size:0.95rem;margin-bottom:1.5rem">Summary of the active user base scaling, cohort breakdowns, and structural assumptions used in this simulation run.</p>
      
      <div class="summary-grid" style="margin-bottom: 2rem;">
        <div class="summary-card" style="padding: 1.2rem;">
          <p class="summary-title" style="margin-bottom: 0.5rem;">Initial Viewers (t=0)</p>
          <p class="summary-value" style="font-size: 1.8rem; color: var(--accent-color);">{cfg.initial_viewers:,.0f}</p>
          <p style="margin: 0.25rem 0 0 0; font-size: 0.8rem; color: var(--text-muted);">{cfg.adoption_profile.replace('_', ' ').title()} adoption curve</p>
        </div>
        <div class="summary-card" style="padding: 1.2rem;">
          <p class="summary-title" style="margin-bottom: 0.5rem;">Creators Pool</p>
          <p class="summary-value" style="font-size: 1.8rem; color: var(--accent-color);">{cfg.creator_population:,.0f}</p>
          <p style="margin: 0.25rem 0 0 0; font-size: 0.8rem; color: var(--text-muted);">{cfg.creator_sell_propensity * 100:.1f}% baseline sell propensity</p>
        </div>
        <div class="summary-card" style="padding: 1.2rem;">
          <p class="summary-title" style="margin-bottom: 0.5rem;">Validators Pool</p>
          <p class="summary-value" style="font-size: 1.8rem; color: var(--accent-color);">{cfg.validator_population:,.0f}</p>
          <p style="margin: 0.25rem 0 0 0; font-size: 0.8rem; color: var(--text-muted);">{cfg.validator_sell_propensity * 100:.1f}% baseline sell propensity</p>
        </div>
        <div class="summary-card" style="padding: 1.2rem;">
          <p class="summary-title" style="margin-bottom: 0.5rem;">Run Horizon</p>
          <p class="summary-value" style="font-size: 1.8rem; color: var(--accent-color);">{cfg.n_epochs:,.0f} Epochs</p>
          <p style="margin: 0.25rem 0 0 0; font-size: 0.8rem; color: var(--text-muted);">~5 years of simulated economic activity</p>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>User Cohort</th>
            <th>Assumed Population Share</th>
            <th>Assumed User Count</th>
            <th>Earning Profile</th>
            <th>Utility Spend Profile</th>
          </tr>
        </thead>
        <tbody>
"""

    cohort_profiles = {
        "passive_viewers": ("Low Claim Rate (10%)", "Low Utility spend (4.56%)"),
        "active_viewers": ("Medium Claim Rate (40%)", "Medium Utility spend (18.23%)"),
        "power_users": ("High Claim Rate (80%)", "High Utility spend (45.57%)"),
        "adversarial_whales": ("Max Claim Rate (100%)", "No Utility spend (0.00%)")
    }

    for name in COHORT_NAMES:
        share = cfg.cohort_population_shares.get(name, 0)
        count = int(cfg.initial_viewers * share)
        earn, spend = cohort_profiles.get(name, ("Custom", "Custom"))
        
        html_template += f"""
          <tr>
            <td class="cohort-name">{name.replace('_', ' ').title()}</td>
            <td>{share * 100:.1f}%</td>
            <td><strong>{count:,.0f}</strong></td>
            <td>{earn}</td>
            <td>{spend}</td>
          </tr>
"""

    html_template += f"""
        </tbody>
      </table>
    </div>

    <!-- Spec-to-Code Parity Matrix -->
    <div class="matrix-section">
      <h2 class="section-title">Spec-to-Code Parity Matrix</h2>
      <p style="color:var(--text-secondary);font-size:0.95rem;margin-bottom:1.5rem">Compares the active simulation pool allocations, timelines, and scaling parameters directly against the target specifications.</p>
      
      <h3 style="margin-top: 1.5rem; margin-bottom: 0.75rem; color: var(--text-primary);">1. Genesis Pool Allocation Parity</h3>
      <table>
        <thead>
          <tr>
            <th>Pool Name</th>
            <th>Target Share</th>
            <th>Actual Share</th>
            <th>Nominal Target (Spec)</th>
            <th>Nominal Actual (Scaled)</th>
            <th>Simulation Actual</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
"""

    for pool, info in parity_results["pools"]["pools"].items():
        status_color = "var(--success-color)" if info["status"] == "PASS" else "var(--warning-color)"
        html_template += f"""
          <tr>
            <td class="cohort-name">{pool}</td>
            <td>{info["target_share"]*100:.1f}%</td>
            <td>{info["actual_share"]*100:.2f}%</td>
            <td>{info["nominal_target"]:,.0f} Z1U</td>
            <td>{info["nominal_actual"]:,.0f} Z1U</td>
            <td>{info["sim_actual"]:,.0f} Z1U</td>
            <td><span style="color:{status_color}; font-weight:600;">{info["status"]}</span></td>
          </tr>
"""

    html_template += f"""
        </tbody>
      </table>

      <h3 style="margin-top: 2rem; margin-bottom: 0.75rem; color: var(--text-primary);">2. Timeline & Budget Scaling Verification</h3>
      <table>
        <thead>
          <tr>
            <th>Dimension</th>
            <th>Specification Target</th>
            <th>Active Code Value</th>
            <th>Diagnostic Status</th>
            <th>Operational Impact / Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="cohort-name">Vesting Timeline</td>
            <td>180d cliff + 730d linear duration</td>
            <td>{parity_results["timeline"]["code_vesting_lag_epochs"]} epoch vesting lag</td>
            <td><span style="color:var(--warning-color); font-weight:600;">{parity_results["timeline"]["status"]}</span></td>
            <td style="font-size:0.85rem; color:var(--text-secondary);">{parity_results["timeline"]["description"]}</td>
          </tr>
          <tr>
            <td class="cohort-name">User Base Budgeting</td>
            <td>Nominal: {parity_results["user_scaling"]["budget_per_user_nominal"]:,.0f} Z1U/user/epoch</td>
            <td>Simulation: {parity_results["user_scaling"]["budget_per_user_sim"]:.4f} Z1U/user/epoch</td>
            <td><span style="color:var(--warning-color); font-weight:600;">{parity_results["user_scaling"]["status"]}</span></td>
            <td style="font-size:0.85rem; color:var(--text-secondary);">{parity_results["user_scaling"]["description"]}</td>
          </tr>
        </tbody>
      </table>
    </div>
"""

    html_template += f"""
    <!-- Parameter Calibration Registry -->
    <div class="matrix-section">
      <h2 class="section-title">Parameter Calibration Registry</h2>
      <p style="color:var(--text-secondary);font-size:0.95rem;margin-bottom:1.5rem">Documents the parameters, unit classifications, default values, sensitivity levels, sweeping ranges, and calibration guidelines.</p>
      <table>
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Unit</th>
            <th>Baseline / Default</th>
            <th>Calibration Range</th>
            <th>Sensitivity</th>
            <th>Description & Calibration Guidelines</th>
          </tr>
        </thead>
        <tbody>
"""

    registry_data = [
        ["TAU_1", "score", "0.20", "[0.10, 0.40]", "Medium", "PCS Cutoff (Casual to Engaged): Cutoff score for casual participants. Value is calibrated based on simulated population score distributions to ensure active audience progression."],
        ["TAU_2", "score", "0.60", "[0.50, 0.80]", "High", "PCS Cutoff (Engaged to Core): Controls access to higher Settlement Ratio (SR) tiers, governance rights, and core eligibility. Extremely sensitive for core cohort retention."],
        ["RELEASE_RATE_E0", "ratio", "0.10", "[0.05, 0.20]", "Medium", "Air-Claim Reserve Fraction: Fraction of Audience Reserve (AR) released at launch for Air-Claim. High rates drain AR too early; low rates underwhelm launch."],
        ["WAVE_SIZE", "count", "5,000", "[1,000, 10,000]", "Low", "Air-Claim Batch Size: Number of claims processed in a batch before PCS recalculation. Calibrates computational overhead against relative fairness."],
        ["THETA_MIN", "ratio", "0.30", "[0.20, 0.50]", "Critical", "Treasury Health Solvency Floor: Solvency boundary for the entire system. Below this, SYS_throttle is activated to preserve solvency."],
        ["SR_BASE", "ratio", "0.1047", "[0.01, 0.50]", "Highest", "ACR-to-Z1U Conversion Rate: Base conversion factor for settlements. Primary control over Z1U drain rate. The most sensitive parameter in the system."],
        ["settlement_cap_epoch", "Z1U", "50,000", "[10k, 200k]", "High", "Solvency Settlement Cap: Maximum aggregate Z1U settled per epoch across all users. Essential anti-stampede mechanism."],
        ["MIN_SETTLE", "ACR", "50.0", "[10.0, 100.0]", "Low", "Minimum Settlement Threshold: Dust threshold to prevent micro-settlement transaction spam."],
        ["LM_RATE", "multiplier/epoch", "0.05", "[0.01, 0.10]", "Medium", "Loyalty Multiplier Increase Rate: Determines the rate of loyalty multiplier increase per active epoch. Drives long-term user retention."],
        ["LM_MAX", "multiplier", "1.50", "[1.20, 2.00]", "Medium", "Maximum Loyalty Multiplier Cap: Bounds maximum loyalty advantage of tenure."],
        ["STREAK_BONUS", "multiplier", "0.10", "[0.05, 0.25]", "Low", "Streak Activity Bonus: Incremental bonus multiplier for unbroken active epochs. Rewards consistent engagement."],
        ["STREAK_WINDOW", "epochs", "8", "[4, 12]", "Low", "Streak Qualification Window: Number of consecutive active epochs required to qualify for the streak bonus."],
        ["sku_prices", "USD", "Dynamic", "[0.99, 999.00]", "Medium", "Utility SKU Pricing: USD-denominated price points. Adjusts Z1U amount dynamically via internal reference rate (similar to Helium Data Credits)."],
        ["fee_rate_g5b", "ratio", "0.34", "[0.10, 0.50]", "High", "Utility Treasury Capture Rate: Capture rate on utility transactions. Primary revenue channel; must be balanced against systemic solvency."],
        ["PAR-28 min_lock_period", "epochs", "12", "[4, 26]", "Medium", "Minimum Governance Lock Period: Prevents flash-governance and vote-and-dump attacks by locking staked Z1U."],
        ["PAR-29 max_lock_period", "epochs", "104", "[26, 156]", "Medium", "Maximum Governance Lock Period: Upper bound on locking duration to cap maximum vote weight accumulation."],
        ["revocation_cooldown", "epochs", "4", "[1, 8]", "Low", "Delegation Revocation Cooldown: Cooldown period on delegation revocation when active votes are open. Prevents manipulation."],
        ["fee_rate_g9b", "ratio", "0.25", "[0.05, 0.50]", "Medium", "Campaign Treasury Capture Rate: Secondary revenue channel capturing a fraction of campaign settlements."],
        ["campaign_min_budget", "Z1U", "5,000", "[1k, 50k]", "Low", "Minimum Campaign Budget: Floor budget to prevent campaign spam and ensure network quality."],
        ["pagerank_cap", "score", "0.05", "[0.01, 0.10]", "High", "PageRank Referral Cap: Upper limit for PageRank-based referral scores to prevent sybil/referral tree gaming."],
        ["min_shannon_entropy", "bits", "2.00", "[1.50, 3.50]", "Medium", "Minimum Shannon Entropy: Threshold for session diversity. Prevents single-action agricultural farming."],
        ["platform_min_engagement", "threshold", "0.10", "[0.05, 0.25]", "Medium", "Platform Minimum Engagement: Threshold to prevent platform-concentration attacks and encourage cross-platform diversity."]
    ]

    for param, unit, base, range_val, sens, desc in registry_data:
        sens_color = "var(--danger-color)" if sens in ["Critical", "Highest"] else "var(--warning-color)" if sens == "High" else "var(--text-primary)"
        html_template += f"""
          <tr>
            <td class="cohort-name">{param}</td>
            <td>{unit}</td>
            <td><strong>{base}</strong></td>
            <td><code>{range_val}</code></td>
            <td><span style="color:{sens_color}; font-weight: 600;">{sens}</span></td>
            <td style="font-size:0.85rem; color:var(--text-secondary);">{desc}</td>
          </tr>
"""

    html_template += f"""
        </tbody>
      </table>
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
    custom_path = None
    if len(sys.argv) > 1:
        for i, arg in enumerate(sys.argv):
            if arg in ("--output", "-o") and i + 1 < len(sys.argv):
                custom_path = sys.argv[i + 1]
                break

    out_dir = "outputs/z1_m3_sims/compare"
    os.makedirs(out_dir, exist_ok=True)
    report_path = os.path.join(out_dir, "parameter_locks_report.html")
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(html_template)
    
    print(f"OK: Created parameter locks HTML report at: {report_path}")

    # Copy to the final docs timestamped folder if it exists
    docs_dir = "docs_final/2026-06-19"
    if os.path.exists(docs_dir):
        docs_path = os.path.join(docs_dir, "parameter_locks_report.html")
        with open(docs_path, "w", encoding="utf-8") as f:
            f.write(html_template)
        print(f"OK: Copied locks report to: {docs_path}")

    # Also output to custom path if provided
    if custom_path:
        custom_dir = os.path.dirname(custom_path)
        if custom_dir:
            os.makedirs(custom_dir, exist_ok=True)
        with open(custom_path, "w", encoding="utf-8") as f:
            f.write(html_template)
        print(f"OK: Copied locks report to custom path: {custom_path}")

if __name__ == "__main__":
    generate_report()
