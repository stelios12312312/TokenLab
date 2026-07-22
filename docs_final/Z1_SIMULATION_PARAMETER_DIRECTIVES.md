# Z1 Simulation Parameter Directives

Status: Draft
Audience: Simulation Engineer (TokenLab)
Purpose: TBD parameter registry, calibration priorities, and structural findings to inform M3 simulation build

---

## 0. Calibration Priorities

| Priority | Directive | Notes |
|----------|-----------|-------|
| #0 | Associate actors with exact PCS tiers | Verify TAU_1, TAU_2 cutoff behavior against simulated population |
| #1 | Air-Claim allocation and vesting calibration | RELEASE_RATE_E0, WAVE_SIZE, vesting schedule parameters |
| #2 | Ongoing PCS weight calibration | Exact weight recommendations for each PCS dimension post-Air-Claim |
| #3 | Referral and diversity normalization thresholds | PageRank cap, Shannon entropy minimum, per-platform engagement floor |
| #4 | Token lifecycle gap analysis | Identify missing parameters, define tracking ranges for key metrics |

---

## 1. TBD Parameter Registry

### 1.1 Tier Classification

| Parameter | Default | Unit | Description | Calibration Notes |
|-----------|---------|------|-------------|-------------------|
| `TAU_1` | TBD | score | PCS cutoff: Casual to Engaged | Value depends on simulated population score distribution |
| `TAU_2` | TBD | score | PCS cutoff: Engaged to Core | Controls access to higher SR, governance, programme eligibility |

### 1.2 Air-Claim

| Parameter | Default | Unit | Description | Calibration Notes |
|-----------|---------|------|-------------|-------------------|
| `RELEASE_RATE_E0` | TBD | ratio | Fraction of Audience Reserve released at launch for Air-Claim | Too high drains AR early; too low underwhelms launch. Sets opening economic conditions |
| `WAVE_SIZE` | TBD | count | Claims processed per batch before PCS recalculation | PCS is relative, so batch size affects fairness vs. computational efficiency tradeoff |

### 1.3 Treasury and Settlement

| Parameter | Default | Unit | Description | Sensitivity | Calibration Notes |
|-----------|---------|------|-------------|-------------|-------------------|
| `THETA_MIN` | TBD | ratio | Treasury health threshold triggering SYS_throttle | HIGH | Defines solvency boundary for the entire system |
| `SR_BASE` | TBD | ratio | ACR-to-Z1U base conversion rate | **HIGHEST** | Primary control over value extraction rate. Most sensitive parameter in the system |
| `settlement_cap_epoch` | TBD | Z1U | Max Z1U settled per epoch across all users | HIGH | Anti-stampede mechanism. Caps aggregate outflow per epoch |
| `MIN_SETTLE` | TBD | ACR | Minimum ACR amount per settlement transaction | LOW | Dust threshold. Prevents micro-settlement spam |

### 1.4 Loyalty and Retention

| Parameter | Default | Unit | Description | Calibration Notes |
|-----------|---------|------|-------------|-------------------|
| `LM_RATE` | TBD | multiplier/epoch | Rate of loyalty multiplier increase per tenure unit | Drives long-term retention incentive curve |
| `LM_MAX` | TBD | multiplier | Maximum loyalty multiplier cap | Bounds maximum advantage of tenure |
| `STREAK_BONUS` | TBD | multiplier | Additional bonus for unbroken activity streak | Rewards consistency over sporadic engagement |
| `STREAK_WINDOW` | TBD | epochs | Consecutive active epochs required for streak qualification | Defines what "unbroken" means operationally |

### 1.5 Utility Consumption

| Parameter | Default | Unit | Description | Calibration Notes |
|-----------|---------|------|-------------|-------------------|
| `sku_prices` | TBD | USD | USD-denominated utility SKU pricing | Z1U amount adjusts dynamically via internal reference rate (Helium Data Credits pattern) |
| `fee_rate_g5b` | TBD | ratio | Treasury capture rate on utility transactions | Primary revenue channel. Must be tested against sustainability equation |

### 1.6 Governance

| Parameter | Default | Unit | Description | Calibration Notes |
|-----------|---------|------|-------------|-------------------|
| `PAR-28 min_lock_period` | TBD | epochs | Minimum lock duration for governance participation | Anti-flash-governance. Prevents vote-and-dump |
| `PAR-29 max_lock_period` | TBD | epochs | Upper bound on lock duration | Bounds maximum governance weight accumulation |
| `revocation_cooldown` | TBD | epochs | Cooling period on delegation revocation with open votes | Prevents mid-vote delegation manipulation |

### 1.7 Campaigns

| Parameter | Default | Unit | Description | Calibration Notes |
|-----------|---------|------|-------------|-------------------|
| `fee_rate_g9b` | TBD | ratio | Treasury capture rate on campaign settlements | Secondary revenue channel |
| `campaign_min_budget` | TBD | Z1U | Minimum budget for campaign creation | Quality floor. Prevents spam campaigns |

### 1.8 Referral and Diversity Normalization (Priority #3)

| Parameter | Default | Unit | Description | Calibration Notes |
|-----------|---------|------|-------------|-------------------|
| `pagerank_cap` | TBD | score | PageRank cap for referral normalization | Prevents referral tree gaming |
| `min_shannon_entropy` | TBD | bits | Minimum Shannon entropy for session diversity | Ensures engagement is not single-action farming |
| `platform_min_engagement` | TBD | threshold | Per-platform minimum engagement threshold | Prevents platform-concentration attacks |

---

## 2. Structural Finding: Treasury Sustainability

### Observation

Under current default operational parameters, utility fees (`fee_rate_g5b`) and campaign fees (`fee_rate_g9b`) together produce a **monthly deficit** against operational outflows (OPEX) and validator reward payments (VRP). The treasury remains solvent during the bootstrap window only because genesis unlock from the Treasury vault (15% of total supply) provides a finite runway.

### Implications for Simulation

1. The sustainability equation (aggregate revenue >= aggregate outflows) needs an **explicit time-horizon qualifier** distinguishing the subsidy phase from steady state
2. Simulation must test whether organic fee revenue can reach breakeven **before genesis unlock exhausts**
3. Key independent variables to sweep: participation rate, consumption rate per user, fee rates
4. The compound health metric for evaluation is **treasury health ratio**, defined as:

```
treasury_health = treasury_balance / (OPEX + VRP + ecosystem_grants + liquidity_provisioning)
```

When `treasury_health < THETA_MIN`, SYS_throttle activates.

Note: G11 (AR Top-up) and G12 (CIP Replenishment) are excluded from the denominator because they are internal routing, not terminal outflows.

### Simulation Directives

- [ ] Identify the epoch at which genesis unlock exhausts under baseline assumptions
- [ ] Sweep `fee_rate_g5b` and `fee_rate_g9b` to find breakeven combinations
- [ ] Test participation ramp scenarios (pessimistic, baseline, optimistic) against treasury runway
- [ ] Report `treasury_health` time series for each scenario
- [ ] Flag any scenario where `treasury_health < THETA_MIN` before month 18

---

## 3. Key Compound Metric Definition

```
treasury_health(t) = treasury_balance(t) / sum(outflows(t))

where outflows(t) = OPEX(t) + VRP(t) + ecosystem_grants(t) + liquidity_provisioning(t)

solvency_constraint: treasury_health(t) >= THETA_MIN for all t
violation_trigger: treasury_health(t) < THETA_MIN => activate SYS_throttle
```

---

## 4. Open Questions for Simulation Engineer

- [ ] What population distribution produces reasonable TAU_1/TAU_2 splits across Casual/Engaged/Core?
- [ ] What RELEASE_RATE_E0 + WAVE_SIZE combination balances launch impact against AR longevity?
- [ ] What SR_BASE range keeps settlements attractive without draining the system?
- [ ] At what participation levels does the sustainability equation flip from deficit to surplus?
- [ ] What min_lock_period prevents flash-governance without suppressing participation?
