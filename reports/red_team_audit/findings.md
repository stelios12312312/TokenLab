# Red Team Audit Findings

## Index
- F-001: Settlement Velocity parameter mismatch (velocity_scale = 0.1 vs 1.0)
- F-002: Tier Settlement Modifiers bonus mismatch (1.05/1.10/1.15 vs 1.1/1.2/1.3)
- F-003: Vesting Extension factor mismatch (2.0 vs 0.10)
- F-004: AMM Peg Defense Failure (target_reserves logic and surplus perpetual loop)

## Substrate Risks
- No significant substrate risks detected. The story registry (`story_registry.json`) is fully defined and active.

## Runtime / Code Findings

### F-001: Settlement Velocity parameter mismatch (velocity_scale = 0.1 vs 1.0)
- **Severity**: HIGH
- **Category**: Business Logic Correctness
- **File(s)**: [config.py](file:///Users/stylianoskampakis/Dropbox%20%28Personal%29/Freelance/TokenLab/projects/z1/m3_full_economy/config.py)
- **Line(s)**: 52
- **Description**: The codebase configures `velocity_scale = 0.1` while the narrative specification specifies a value of `1.0`. At `0.1`, a user with a maximum activity score / propensity can only settle 10% of their available ACR balance per epoch, resulting in a 10x slower settlement rate.
- **Impact**: Underestimates the system's actual settlement pressure and circulation velocity by 10x under normal operating conditions.
- **Reproduction**: Observed value in [config.py](file:///Users/stylianoskampakis%20%28Personal%29/Freelance/TokenLab/projects/z1/m3_full_economy/config.py): `velocity_scale: float = 0.1`.
- **Recommended Fix**: Update `velocity_scale` to `1.0` in [config.py](file:///Users/stylianoskampakis/Dropbox%20%28Personal%29/Freelance/TokenLab/projects/z1/m3_full_economy/config.py).

### F-002: Tier Settlement Modifiers bonus mismatch (1.05/1.10/1.15 vs 1.1/1.2/1.3)
- **Severity**: HIGH
- **Category**: Business Logic Correctness
- **File(s)**: [config.py](file:///Users/stylianoskampakis/Dropbox%20%28Personal%29/Freelance/TokenLab/projects/z1/m3_full_economy/config.py)
- **Line(s)**: 55-57
- **Description**: The codebase configures halved bonus increments for Silver, Gold, and Platinum tiers (1.05x, 1.10x, 1.15x) compared to the specification's values (1.10x, 1.20x, 1.30x).
- **Impact**: Mismatches the incentives designed for core participants, reducing the motivation for progressive tier climbing.
- **Reproduction**: Observed value in [config.py](file:///Users/stylianoskampakis%20%28Personal%29/Freelance/TokenLab/projects/z1/m3_full_economy/config.py): `tier_sr_modifiers: Dict[str, float] = field(default_factory=lambda: {"Bronze": 1.0, "Silver": 1.05, "Gold": 1.10, "Platinum": 1.15})`.
- **Recommended Fix**: Update modifiers in [config.py](file:///Users/stylianoskampakis/Dropbox%20%28Personal%29/Freelance/TokenLab/projects/z1/m3_full_economy/config.py) to match the spec: `{"Bronze": 1.0, "Silver": 1.10, "Gold": 1.20, "Platinum": 1.30}`.

### F-003: Vesting Extension factor mismatch (2.0 vs 0.10)
- **Severity**: MEDIUM
- **Category**: Business Logic Correctness
- **File(s)**: [config.py](file:///Users/stylianoskampakis/Dropbox%20%28Personal%29/Freelance/TokenLab/projects/z1/m3_full_economy/config.py)
- **Line(s)**: 91
- **Description**: The codebase configures `vesting_extension_factor = 2.0` (doubling vesting lag under stress), but it is a dead parameter that is never actually applied in `ledger.py` or `economy.py`. The narrative specifies a 10% incremental extension rate (`0.10`).
- **Impact**: The vesting extension parameter is completely bypassed in the active simulation loops, and its value is mismatched.
- **Reproduction**: Observed value in [config.py](file:///Users/stylianoskampakis%20%28Personal%29/Freelance/TokenLab/projects/z1/m3_full_economy/config.py): `vesting_extension_factor: float = 2.0`.
- **Recommended Fix**: Update the parameter to `0.10` and integrate it into the `vest_acr` logic inside [economy.py](file:///Users/stylianoskampakis/Dropbox%20%28Personal%29/Freelance/TokenLab/projects/z1/m3_full_economy/economy.py) or [ledger.py](file:///Users/stylianoskampakis/Dropbox%20%28Personal%29/Freelance/TokenLab/projects/z1/m3_full_economy/ledger.py).

### F-004: AMM Peg Defense Failure (target_reserves logic and surplus perpetual loop)
- **Severity**: CRITICAL
- **Category**: Data Integrity / Business Logic Correctness
- **File(s)**: [economy.py](file:///Users/stylianoskampakis/Dropbox%20%28Personal%29/Freelance/TokenLab/projects/z1/m3_full_economy/economy.py)
- **Line(s)**: 317-328
- **Description**: The buyback logic calculates `target_reserves = current_live_supply * self.config.treasury_topup_target_ratio` (40% of ~30M = 12M Z1U), which is always larger than the treasury balance (peaks at 7.9M Z1U). Thus, `surplus` is always zero, rendering the peg defense buybacks inactive (failing the actual purpose of Lock L8). Furthermore, if buybacks do run under a fixed target threshold, calculating `usd_to_spend` as `surplus * spot_price * buyback_ratio` creates an infinite virtual USD injection loop because the treasury does not track a USD balance. Finally, peg defense should only buy back tokens if the spot price falls below the peg ($0.10).
- **Impact**: The peg floor is undefended in the simulation, causing the price to collapse to zero in standard stress runs. If active, it creates a perpetual motion machine that drives the price to infinity.
- **Reproduction**: Standard run outputs show peg defense never triggers when `treasury_buyback_ratio = 0.10`, and modifying target reserves without a price-floor check causes the price to skyrocket to $14,000+.
- **Recommended Fix**: Modify [economy.py](file:///Users/stylianoskampakis/Dropbox%20%28Personal%29/Freelance/TokenLab/projects/z1/m3_full_economy/economy.py) to:
  1. Base `target_reserves` on the treasury's own initial target `self.config.treasury_initial * self.config.treasury_topup_target_ratio`.
  2. Only trigger buyback if `self.amm.spot_price < self.amm.initial_spot_price`.

## Formal / Ontology Findings
- None. The Prolog invariants passed successfully.

## Priority Order
1. **F-004 (CRITICAL)**: AMM Peg Defense Failure.
2. **F-001 (HIGH)**: Settlement Velocity parameter mismatch.
3. **F-002 (HIGH)**: Tier Settlement Modifiers bonus mismatch.
4. **F-003 (MEDIUM)**: Vesting Extension factor mismatch.
