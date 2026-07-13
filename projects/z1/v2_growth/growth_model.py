# projects/z1/v2_growth/growth_model.py
# @planner:module = v2_growth_model
# @planner:story = US-Z1-M3-09

import numpy as np
import pandas as pd
import math
from scripts.ledger_anchors import anchor_value

class V2GrowthModule:
    """
    US-Z1-M3-09: Pre-simulation growth configuration generator.
    Models 11 funnel conversion stages and retention-based user churn.
    Converts PDF-calibrated nominal values to simulation scale and exports growth schedules.
    """
    def __init__(self, scheme_id: int, n_epochs: int = 260, scale_factor: float = 1/33_333.33):
        self.scheme_id = scheme_id
        self.n_epochs = n_epochs
        self.scale_factor = scale_factor

        self.ledger_anchors = {
            "cumulative_reach_ceiling": anchor_value("cumulative_engaged_audience_total"),
            "domestic_cumulative_reach_ceiling": anchor_value("cumulative_engaged_audience_domestic"),
            "international_cumulative_reach_ceiling": anchor_value("cumulative_engaged_audience_international"),
            "existing_cdp_identity_stock": anchor_value("cdp_unified_identity_stock"),
            "registered_zee5_stock": anchor_value("zee5_registered_user_stock"),
            "monthly_active_user_stock": anchor_value("monthly_active_user_stock"),
            "gold_profile_stock": anchor_value("gold_profile_stock"),
            "silver_profile_stock": anchor_value("silver_profile_stock"),
            "bronze_profile_stock": anchor_value("bronze_profile_stock"),
            "registration_wall_conversion": anchor_value("registration_wall_conversion_rate"),
            "otp_verification_conversion": anchor_value("otp_verification_rate"),
        }
        self.production_adoption_family = "state_transition_hazard"
        self.linear_profile_role = "control_only"
        self.profile_tier_semantics = (
            "Gold/Silver/Bronze are CDP completeness tiers and must not map directly "
            "to passive/active/power user behavior cohorts."
        )
        
        # Default baseline funnel conversion parameters
        self.funnel_params = {
            "tam": self.ledger_anchors["cumulative_reach_ceiling"],  # Stage 1: historical reach ceiling
            "cdp_ratio": self.ledger_anchors["existing_cdp_identity_stock"] / self.ledger_anchors["cumulative_reach_ceiling"],
            "exposed_ratio": self.ledger_anchors["monthly_active_user_stock"] / self.ledger_anchors["existing_cdp_identity_stock"],
            "participation_ratio": 0.60,            # Stage 4: Participants
            "registration_ratio": self.ledger_anchors["registration_wall_conversion"],
            # Legacy deterministic V2 reconciliation target. Ledger state columns use the
            # explicit OTP anchor after claim/OTP attempt.
            "verification_ratio": 35_000_000 / 45_000_000,
            "pcs_eligible_ratio": 0.60,             # Stage 7: Eligible (Sybil/tenure/activity filter)
            "claim_ratio": 0.50,                    # Stage 8: Claimants
            "settle_ratio": 0.55,                   # Stage 9: Settlers
            "utility_spend_ratio": 0.65,            # Stage 10: Spenders
            "staking_ratio": 0.20                   # Stage 11: Stakers
        }
        
        # Retention rates per epoch (Stage 5 onward)
        self.retention_rates = {
            5: 0.995,  # Registered
            6: 0.995,  # Verified
            7: 0.992,  # Eligible
            8: 0.990,  # Claimants
            9: 0.985,  # Settlers
            10: 0.980, # Spenders
            11: 0.995  # Stakers
        }
        
        # Configure the 6 named growth schemes
        self.configure_scheme()

    def configure_scheme(self):
        if self.scheme_id == 1:
            # Conservative Recognition
            self.curve_type = "logistic_s_curve"
            self.curve_params = {"L": 0.35, "k": 0.02, "t0": 100} # slower growth, lower asymptote
            self.funnel_params["claim_ratio"] *= 0.5
            self.funnel_params["utility_spend_ratio"] *= 0.8
        elif self.scheme_id == 2:
            # Base Case Growth
            self.curve_type = "logistic_s_curve"
            self.curve_params = {"L": 0.55, "k": 0.03, "t0": 80}
        elif self.scheme_id == 3:
            # Aggressive Phygital Scaling
            self.curve_type = "logistic_s_curve"
            self.curve_params = {"L": 0.85, "k": 0.05, "t0": 60} # fast growth, high asymptote
            self.funnel_params["claim_ratio"] = min(1.0, self.funnel_params["claim_ratio"] * 1.5)
        elif self.scheme_id == 4:
            # Reality-TV High-Intensity
            self.curve_type = "campaign_pulse_growth"
            # Pulses at show season epochs (finale jumps)
            self.curve_params = {"base_exposed": 0.40, "pulses": [(50, 0.10), (100, 0.15), (150, 0.15), (200, 0.15)]}
        elif self.scheme_id == 5:
            # International Expansion (Uses Bass Diffusion model)
            self.curve_type = "bass_diffusion"
            self.curve_params = {"p": 0.005, "q": 0.04, "m": 0.65}
        elif self.scheme_id == 6:
            # Failure / Overclaim
            self.curve_type = "logistic_s_curve"
            self.curve_params = {"L": 0.90, "k": 0.08, "t0": 40} # massive rapid spike
            self.funnel_params["claim_ratio"] = min(1.0, self.funnel_params["claim_ratio"] * 2.0)
            self.funnel_params["utility_spend_ratio"] *= 0.3
        else:
            raise ValueError(f"Unknown growth scheme ID: {self.scheme_id}")

    def _adoption_curve_fraction(self, t: int) -> float:
        if self.curve_type == "logistic_s_curve":
            L = self.curve_params["L"]
            k = self.curve_params["k"]
            t0 = self.curve_params["t0"]
            f0 = L / (1.0 + math.exp(k * t0))
            return max(0.0, L / (1.0 + math.exp(-k * (t - t0))) - f0)
        if self.curve_type == "bass_diffusion":
            p = self.curve_params["p"]
            q = self.curve_params["q"]
            m = self.curve_params["m"]
            pq = p + q
            return ((1.0 - math.exp(-pq * t)) / (1.0 + (q / p) * math.exp(-pq * t))) * m
        if self.curve_type == "campaign_pulse_growth":
            val = self.curve_params["base_exposed"]
            for p_t, p_val in self.curve_params["pulses"]:
                if t >= p_t:
                    val += p_val
            return min(1.0, val)
        if self.curve_type == "linear_control":
            return min(1.0, t / max(1, self.n_epochs))
        return self.funnel_params["exposed_ratio"]

    def _ledger_state_values(self, t: int) -> dict:
        anchors = self.ledger_anchors
        installed_stock = anchors["existing_cdp_identity_stock"]
        active_stock = anchors["monthly_active_user_stock"]
        adoption_fraction = self._adoption_curve_fraction(t)

        z1_aware = min(installed_stock, active_stock + installed_stock * adoption_fraction * 0.45)
        eligible = z1_aware * 0.60
        claim_attempt = eligible * self.funnel_params["claim_ratio"]
        verified_claimant = claim_attempt * anchors["otp_verification_conversion"]
        active_participant = verified_claimant * 0.70
        utility_user = active_participant * self.funnel_params["utility_spend_ratio"]
        settlement_participant = verified_claimant * self.funnel_params["settle_ratio"]

        dormant = max(0.0, verified_claimant - active_participant)
        churned = active_participant * (1.0 - self.retention_rates[8])
        reactivated = dormant * 0.08

        return {
            "existing_cdp_identity_stock": installed_stock,
            "cumulative_reach_ceiling": anchors["cumulative_reach_ceiling"],
            "z1_aware": z1_aware,
            "eligible": eligible,
            "claim_attempt": claim_attempt,
            "verified_claimant": verified_claimant,
            "active_participant": active_participant,
            "utility_user": utility_user,
            "settlement_participant": settlement_participant,
            "dormant": dormant,
            "churned": churned,
            "reactivated": reactivated,
        }

    def generate_schedule(self) -> pd.DataFrame:
        schedule = []
        
        # We model the cumulative stock at each stage first, then compute incremental entrants
        # to apply retention churn.
        # Cumulative arrays (before churn)
        cum_users = {stage: np.zeros(self.n_epochs + 1) for stage in range(1, 12)}
        active_users = {stage: np.zeros(self.n_epochs + 1) for stage in range(1, 12)}
        
        tam = self.funnel_params["tam"]
        cdp = tam * self.funnel_params["cdp_ratio"]
        
        for t in range(self.n_epochs + 1):
            # Stage 1: TAM
            cum_users[1][t] = tam
            
            # Stage 2: CDP
            cum_users[2][t] = cdp
            
            # Stage 3: Exposed (S-curve, Bass, Pulse, or linear control)
            exposed = cdp * self._adoption_curve_fraction(t)
                
            cum_users[3][t] = exposed
            
            # Stage 4: Participants
            cum_users[4][t] = exposed * self.funnel_params["participation_ratio"]
            
            # Stages 5 to 11 are linear conversions of the preceding cumulative stock
            for stage in range(5, 12):
                prev_cum = cum_users[stage - 1][t]
                conversion_keys = [
                    "", "", "", "", "",
                    "registration_ratio",
                    "verification_ratio",
                    "pcs_eligible_ratio",
                    "claim_ratio",
                    "settle_ratio",
                    "utility_spend_ratio",
                    "staking_ratio"
                ]
                conv_rate = self.funnel_params[conversion_keys[stage]]
                cum_users[stage][t] = prev_cum * conv_rate
                
        # Now compute active users by applying retention churn to incremental new entrants
        for stage in range(1, 12):
            if stage < 5:
                # No churn for stages 1 to 4
                active_users[stage] = cum_users[stage].copy()
            else:
                # Churn model for stage 5 onward
                retention = self.retention_rates[stage]
                for t in range(self.n_epochs + 1):
                    active_at_t = 0.0
                    for prev_t in range(t + 1):
                        # Incremental new entrants at prev_t
                        if prev_t == 0:
                            new_entrants = cum_users[stage][0]
                        else:
                            new_entrants = max(0.0, cum_users[stage][prev_t] - cum_users[stage][prev_t - 1])
                        
                        active_at_t += new_entrants * (retention ** (t - prev_t))
                    active_users[stage][t] = active_at_t
                    
        # Package into DataFrame
        for t in range(self.n_epochs + 1):
            row = {"epoch": t, "scheme_id": self.scheme_id}
            for stage in range(1, 12):
                nom_val = active_users[stage][t]
                sim_val = nom_val * self.scale_factor
                row[f"stage_{stage}_nominal"] = nom_val
                row[f"stage_{stage}_sim"] = sim_val
                
            # Add cumulative stage 8 (claimants)
            row["stage_8_cumulative_nominal"] = cum_users[8][t]
            row["stage_8_cumulative_sim"] = cum_users[8][t] * self.scale_factor

            for state_name, nominal in self._ledger_state_values(t).items():
                row[f"ledger_{state_name}_nominal"] = nominal
                row[f"ledger_{state_name}_sim"] = nominal * self.scale_factor
            
            schedule.append(row)
            
        return pd.DataFrame(schedule)


