# Z1 Simulation V2 Mega Prompt

Use this handoff prompt for the data scientist / simulation harness.

```yaml
task_name: "Z1 Simulation V2: Investor-Grade Growth, Sensitivity, and Scenario Pack"

role:
  title: "Senior simulation data scientist and CFO-style growth modeller"
  objective: >
    Upgrade the existing TokenLab Z1 simulation into a V2 simulation and analysis package
    that can support investor-facing growth narratives, solvency claims, sensitivity analysis,
    and parameter-backed scenario discussions.

source_repo:
  url: "https://github.com/stelios12312312/TokenLab/tree/z1-simulation"
  primary_modules:
    - "projects/z1/core_solvency"
    - "projects/z1/m2_market_dynamics"
    - "projects/z1/m3_full_economy"
  current_architecture_summary: >
    TokenLab is a cohort-based economic simulation library. Z1 currently subclasses
    TokenEconomy_Basic but largely bypasses the standard MV=PT loop in favor of bespoke
    ledger/state transitions. Treat it as a balance-sheet and behavioral state-machine
    simulation, not only as a generic tokenomics simulator.

source_pdf:
  file_name: "ZEE Audience Participatory Ledger(1).pdf"
  extraction_requirement: >
    Extract growth and funnel assumptions directly from the PDF. Do not manually invent
    audience-growth numbers unless the assumption is explicitly marked as synthetic.
    Treat the 1.45B audience figure as a historical cumulative engaged audience census,
    not as a point-in-time active user count and not as a forward projection.

mission:
  build_v2_that_delivers:
    - "Exhaustive parameter inventory and sensitivity analysis across every simulation parameter."
    - "Growth projections derived from the PDF evidence base."
    - "Investor-facing CFO-style growth schemes paired with simulation outputs."
    - "Clear separation between historical evidence, calibrated assumptions, and speculative forecasts."

non_negotiables:
  - "No cherry-picked parameters. Every parameter in config dataclasses must appear in the parameter registry."
  - "Every dictionary parameter must be expanded by cohort, tier, region, or mechanism."
  - "Every parameter must have baseline, lower bound, upper bound, source, rationale, and sensitivity status."
  - "If a parameter cannot be grounded in the repo or PDF, mark it as ASSUMED and explain the assumption."
  - "Do not present cumulative historical audience as current active audience."
  - "Do not only run optimistic cases. Include downside, stress, and failure cases."
  - "Investor outputs must reconcile growth with reserve health, treasury runway, settlement obligations, and market pressure."

pdf_extraction_targets:
  audience_base:
    required_fields:
      - "total_cumulative_engaged_audience"
      - "domestic_cumulative_audience"
      - "international_cumulative_audience"
      - "international_region_split"
      - "domestic_channel_cluster_split"
      - "content_affinity_split"
      - "reality_tv_high_intensity_interaction_share"
    known_values_to_verify:
      total_cumulative_engaged_audience: 1450000000
      domestic_cumulative_audience: 1050000000
      international_cumulative_audience: 400000000
      fiction_share_of_cumulative_audience: 0.53
      reality_tv_share_of_cumulative_audience: 0.124
      reality_tv_share_of_high_intensity_interactions: 0.80

  cdp_and_first_party_data:
    required_fields:
      - "total_unified_user_ids"
      - "zee5_registered_users"
      - "monthly_active_users"
      - "verified_phone_numbers"
      - "email_addresses"
      - "profiles_with_pin_or_delivery_address"
      - "profiles_with_full_viewing_history"
      - "multi_year_participation_records"
      - "registration_conversion_rate"
      - "gold_coin_campaign_cpa"
    known_values_to_verify:
      total_unified_user_ids: 220000000
      zee5_registered_users: 180000000
      monthly_active_users: 95000000
      profiles_with_full_viewing_history: 95000000
      multi_year_participation_records: 45000000
      profiles_with_pin_or_delivery_address: 35000000
      gold_coin_campaign_cpa_inr: 0.35
      zee5_registration_conversion_rate: 0.67

  phygital_mechanism_table:
    extract_mechanisms:
      - "QR Code"
      - "WhatsApp Chatbot"
      - "OBD Callback"
      - "Voice Assistant"
      - "ZEE5 Registration Wall"
      - "Gold Coin Campaign"
    required_fields_per_mechanism:
      - "data_captured"
      - "per_user_value_low_inr"
      - "per_user_value_high_inr"
      - "peak_campaign_volume"
      - "evidentiary_weight"
      - "conversion_or_completion_rate_if_available"
    known_values_to_verify:
      qr_value_range_inr: [45, 80]
      whatsapp_value_range_inr: [60, 100]
      obd_value_inr: 11
      voice_value_range_inr: [80, 120]
      zee5_registration_wall_value_range_inr: [180, 240]
      gold_coin_2024_unique_users: 581684

parameter_inventory:
  scan_files:
    - "projects/z1/core_solvency/config.py"
    - "projects/z1/m2_market_dynamics/config.py"
    - "projects/z1/m3_full_economy/config.py"
  required_output: "outputs/v2/parameter_registry.csv"
  columns:
    - "module"
    - "parameter_name"
    - "expanded_key"
    - "type"
    - "baseline_value"
    - "lower_bound"
    - "upper_bound"
    - "distribution"
    - "source"
    - "source_quote_or_reference"
    - "rationale"
    - "sensitivity_method"
    - "included_in_sobol"
    - "included_in_oat"
    - "included_in_scenario_matrix"
    - "notes"
  coverage_rules:
    numeric_parameters:
      - "Run one-at-a-time sweeps for every numeric parameter."
      - "Run global sensitivity for all high-materiality numeric parameters."
      - "Use Morris screening first if Sobol is too expensive."
      - "Use Sobol or quasi-Monte Carlo for the final reduced parameter set."
    boolean_parameters:
      - "Evaluate both true and false states."
    categorical_parameters:
      - "Evaluate all allowed categories."
    dictionary_parameters:
      - "Expand by key and analyze each key separately."
      - "Also analyze grouped shocks, such as all viewer cohorts up/down together."
    constrained_parameters:
      - "Respect validation locks and invariants."
      - "If a sweep violates a hard invariant, record the failure as an infeasible region, not as a normal run."

v2_modeling_requirements:
  add_or_improve:
    endogenous_growth_loop:
      description: >
        Current adoption is mostly a static timeline curve. Add a growth module that converts
        historical audience evidence into scenario-based adoption and activation paths.
      funnel:
        - "cumulative_addressable_audience"
        - "reachable_audience"
        - "campaign_exposed_users"
        - "participants"
        - "registered_users"
        - "verified_profiles"
        - "eligible_acr_users"
        - "claimants"
        - "settlers"
        - "utility_spenders"
        - "stakers"
      growth_curve_types:
        - "logistic_s_curve"
        - "bass_diffusion"
        - "cohort_retention_decay"
        - "campaign_pulse_growth"
      scenario_modes:
        - "conservative"
        - "base"
        - "upside"
        - "stress"
        - "failed_activation"

    cfo_projection_layer:
      projection_horizon_years: [3, 5]
      required_outputs:
        - "registered_users_projection"
        - "verified_profiles_projection"
        - "monthly_active_users_projection"
        - "campaign_participant_projection"
        - "claimant_projection"
        - "settlement_demand_projection"
        - "utility_spend_projection"
        - "treasury_fee_revenue_projection"
        - "provider_payment_projection"
        - "burn_projection"
        - "audience_reserve_health_projection"
        - "treasury_runway_projection"
        - "required_topup_projection"
        - "buyback_requirement_projection"
        - "net_protocol_cashflow_projection"
        - "data_asset_value_projection"
        - "implied_unit_economics"
      cfo_metrics:
        - "CAC_or_CPA"
        - "verified_user_value"
        - "gross_margin_proxy"
        - "payback_period"
        - "LTV_to_CAC"
        - "treasury_runway_months"
        - "reserve_coverage_ratio"
        - "settlement_liability_coverage"
        - "scenario_NPV_if_relevant"
        - "break_even_campaign_scale"
        - "downside_capital_required"

    investor_growth_schemes:
      required_schemes:
        - name: "Conservative Recognition Scheme"
          description: "Low activation, slow conversion, high reserve discipline, lower ACR settlement pressure."
        - name: "Base Case Growth Scheme"
          description: "Moderate campaign expansion using PDF-derived CDP and phygital benchmarks."
        - name: "Aggressive Phygital Scaling Scheme"
          description: "Higher QR, WhatsApp, OBD, and ZEE5 conversion assumptions; must test reserve stress."
        - name: "Reality-TV High-Intensity Scheme"
          description: "Uses reality TV as the primary activation engine because it drives disproportionate high-intensity interaction."
        - name: "International Expansion Scheme"
          description: "Uses Africa, APAC, MENA, Europe/UK, and Americas splits as separate growth markets."
        - name: "Failure / Overclaim Scheme"
          description: "High claims, weak utility spend, weak campaign inflow, sell pressure, AMM stress, treasury depletion."

sensitivity_analysis:
  required_methods:
    - "one_at_a_time_sweeps"
    - "morris_screening"
    - "sobol_or_quasi_monte_carlo_on_reduced_set"
    - "scenario_matrix"
    - "stress_grid"
    - "tornado_chart_for_cfo_outputs"
    - "partial_dependence_or_response_curves_for_key_parameters"
  target_outputs:
    solvency_outputs:
      - "final_audience_reserve"
      - "min_audience_reserve"
      - "ar_floor_breach_count"
      - "treasury_final"
      - "treasury_runway_months"
      - "settlement_queue_peak"
      - "settlement_executed_total"
      - "throttle_activation_count"
    market_outputs:
      - "final_amm_price"
      - "min_amm_price"
      - "price_volatility"
      - "panic_epochs"
      - "buyback_spend"
      - "sell_pressure"
    growth_outputs:
      - "registered_users"
      - "verified_profiles"
      - "active_users"
      - "claimants"
      - "utility_spenders"
      - "stakers"
    financial_outputs:
      - "campaign_revenue"
      - "treasury_fee_revenue"
      - "provider_payments"
      - "burn"
      - "data_asset_value"
      - "net_protocol_cashflow"
      - "capital_required"
  required_visuals:
    - "parameter_importance_tornado"
    - "sobol_first_order_and_total_order"
    - "reserve_health_heatmaps"
    - "growth_funnel_projection_chart"
    - "treasury_runway_chart"
    - "scenario_comparison_table"
    - "investor_case_waterfall"
    - "failure_boundary_chart"

simulation_execution:
  baseline_runs:
    - "M1 baseline"
    - "M2 baseline"
    - "M3 baseline"
  scenario_runs:
    - "conservative"
    - "base"
    - "upside"
    - "stress"
    - "panic"
    - "low_campaign_inflow"
    - "high_claim_rate"
    - "high_settlement_propensity"
    - "low_utility_spend"
    - "weak_buyback_defense"
    - "international_growth"
    - "reality_tv_activation"
  repetitions:
    minimum_for_stochastic_runs: 100
    preferred_for_final_runs: 1000
  random_seed_policy:
    - "Use deterministic seeds for reproducibility."
    - "Store all seeds in run metadata."
    - "Every output table must include run_id, scenario_id, and config_hash."

deliverables:
  data_files:
    - "outputs/v2/pdf_extracted_metrics.json"
    - "outputs/v2/pdf_extracted_metrics.csv"
    - "outputs/v2/parameter_registry.csv"
    - "outputs/v2/scenario_definitions.yaml"
    - "outputs/v2/simulation_results.parquet"
    - "outputs/v2/sensitivity_results.csv"
    - "outputs/v2/cfo_projection_model.xlsx"
  reports:
    - "outputs/v2/V2_SIMULATION_FINDINGS.md"
    - "outputs/v2/INVESTOR_GROWTH_SCHEMES.md"
    - "outputs/v2/CFO_MODEL_ASSUMPTIONS.md"
    - "outputs/v2/SENSITIVITY_ANALYSIS_REPORT.md"
    - "outputs/v2/FAILURE_BOUNDARIES.md"
  notebooks_or_scripts:
    - "notebooks/01_pdf_extraction_and_parameter_mapping.ipynb"
    - "notebooks/02_baseline_and_growth_projection.ipynb"
    - "notebooks/03_parameter_sweeps_and_sensitivity.ipynb"
    - "notebooks/04_cfo_investor_outputs.ipynb"
    - "scripts/run_v2_all.py"
  visuals:
    - "outputs/v2/figures/growth_funnel.png"
    - "outputs/v2/figures/reserve_health_by_scenario.png"
    - "outputs/v2/figures/parameter_tornado.png"
    - "outputs/v2/figures/sobol_indices.png"
    - "outputs/v2/figures/investor_case_comparison.png"

acceptance_criteria:
  - "Every config parameter from M1, M2, and M3 appears in parameter_registry.csv."
  - "Every investor-facing assumption is traceable to PDF, repo default, calculated value, or explicit assumption."
  - "Historical PDF figures are separated from forecasted figures."
  - "At least one conservative, base, upside, and failure case is fully simulated."
  - "Sensitivity analysis identifies the top 10 parameters affecting reserve health, treasury runway, price stability, and growth value."
  - "CFO outputs reconcile user growth with treasury/reserve constraints."
  - "The final narrative explains not only what grows, but what breaks first when growth is too aggressive."

final_instruction:
  >
    Produce a V2 simulation package that a CFO, investor, or board member could inspect.
    The output should not merely say that the ecosystem can grow. It must show under which
    assumptions growth is solvent, under which assumptions it becomes fragile, and which
    parameters control the transition from attractive growth to reserve stress.
```
