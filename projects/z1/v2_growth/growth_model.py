# projects/z1/v2_growth/growth_model.py
# @planner:module = v2_growth_model
# @planner:story = US-Z1-M3-09

import numpy as np
import pandas as pd
import math

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
        
        # Default baseline funnel conversion parameters
        self.funnel_params = {
            "tam": 1_450_000_000,                  # Stage 1: Addressable
            "cdp_ratio": 220_000_000 / 1_450_000_000, # Stage 2: Reachable (15.17%)
            "exposed_ratio": 95_000_000 / 220_000_000, # Stage 3: Exposed (MAUs / CDP ~ 43.18%)
            "participation_ratio": 0.60,            # Stage 4: Participants
            "registration_ratio": 0.67,             # Stage 5: Registered (ZEE5 rate ~ 67%)
            "verification_ratio": 35_000_000 / 45_000_000, # Stage 6: Verified profiles (~77.78%)
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
            
            # Stage 3: Exposed (S-curve, Bass, or Pulse)
            if self.curve_type == "logistic_s_curve":
                L = self.curve_params["L"]
                k = self.curve_params["k"]
                t0 = self.curve_params["t0"]
                # Shift to start at exactly 0 at t=0
                f0 = L / (1.0 + math.exp(k * t0))
                exposed_fraction = L / (1.0 + math.exp(-k * (t - t0))) - f0
                exposed = cdp * max(0.0, exposed_fraction)
            elif self.curve_type == "bass_diffusion":

                p = self.curve_params["p"]
                q = self.curve_params["q"]
                m = self.curve_params["m"]
                pq = p + q
                F_t = (1.0 - math.exp(-pq * t)) / (1.0 + (q / p) * math.exp(-pq * t))
                exposed = cdp * F_t * m
            elif self.curve_type == "campaign_pulse_growth":
                val = self.curve_params["base_exposed"]
                for p_t, p_val in self.curve_params["pulses"]:
                    if t >= p_t:
                        val += p_val
                exposed = cdp * min(1.0, val)
            else:
                exposed = cdp * self.funnel_params["exposed_ratio"]
                
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
            
            schedule.append(row)
            
        return pd.DataFrame(schedule)


