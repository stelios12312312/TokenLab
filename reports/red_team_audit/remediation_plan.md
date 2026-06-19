# Red Team Audit Remediation Plan

This plan outlines the priority order, dependency mapping, and effort estimation to resolve all identified findings.

## Remediation Steps

### Step 1: Fix AMM Peg Defense Failure (F-004)
- **Priority**: CRITICAL
- **Dependency**: None
- **Estimated Effort**: 4 hours
- **Fix Description**: Modify the treasury buyback target reserve calculation to be based on initial reserves rather than total live supply. Add a spot price floor check to ensure buybacks only execute when the token price falls below the initial peg price ($0.10), preventing the virtual USD loop.

### Step 2: Spec-Align Configuration Parameters (F-001, F-002, F-003)
- **Priority**: HIGH
- **Dependency**: None
- **Estimated Effort**: 2 hours
- **Fix Description**: Update `velocity_scale` to `1.0`, `tier_sr_modifiers` to `1.10x/1.20x/1.30x`, and `vesting_extension_factor` to `0.10` in `config.py`.

### Step 3: Implement Vesting Extension Parameter in Simulation Logic (F-003)
- **Priority**: MEDIUM
- **Dependency**: Step 2
- **Estimated Effort**: 2 hours
- **Fix Description**: Integrate `vesting_extension_factor` into the `vest_acr` call inside `economy.py` so that vesting shifts are slowed down appropriately under stress.

### Step 4: Re-run Simulations & Regenerate Reports (F-004)
- **Priority**: HIGH
- **Dependency**: Step 1, Step 2, Step 3
- **Estimated Effort**: 1 hour
- **Fix Description**: Execute Monte Carlo stochastic demand stress tests and comparative M2/M3 simulations to produce the calibrated outputs. Regenerate the HTML parameter locks validation report.
