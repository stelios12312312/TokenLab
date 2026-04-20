# Z1 M1 Core Solvency Model Report

## 1. Purpose of the model
This is a directional solvency model meant to test whether the Z1 Audience Reserve and Treasury loop can survive under plausible structural stress.

## 2. What M1 includes
Reduced-form claiming/verification, delayed ACR vesting, settlement queues constrained by AR caps, utility spend split into fees/burn/provider transfers, external brand inflows, and a health throttle. M1 checks pure solvency.

## 3. What M1 explicitly defers
It explicitly defers endogenous market prices, adversarial tracking, campaign lifecycles, and creator/validator dynamics.

## 4. Specific Case Findings

### collapse_case
- **Classification**: collapse
- **Final AR Ratio**: 0.00
- **Max Settlement Queue (Z1U)**: 15,549,066
- **Throttle Epochs**: 76


## 10. Known limitations
M1 tests structure, not final calibration. Results depend on provisional parameter guesses and a non-exogenous price. 

## 11. Recommended M2 extensions
Endogenous pricing, detailed campaign pools, and adversarial agent behavior.
