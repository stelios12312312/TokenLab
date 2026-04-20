# Z1 M1 Core Solvency Model Report

## 1. Purpose of the model
This is a directional solvency model meant to test whether the Z1 Audience Reserve and Treasury loop can survive under plausible structural stress.

## 2. What M1 includes
Reduced-form claiming/verification, delayed ACR vesting, settlement queues constrained by AR caps, utility spend split into fees/burn/provider transfers, external brand inflows, and a health throttle. M1 checks pure solvency.

## 3. What M1 explicitly defers
It explicitly defers endogenous market prices, adversarial tracking, campaign lifecycles, and creator/validator dynamics.

## 4. Specific Case Findings

### shock_low_pressure_low_support_low
- **Classification**: collapse
- **Final AR Ratio**: 0.00
- **Max Settlement Queue (Z1U)**: 3,967,274
- **Throttle Epochs**: 74

### shock_low_pressure_low_support_base
- **Classification**: collapse
- **Final AR Ratio**: 0.01
- **Max Settlement Queue (Z1U)**: 3,355,394
- **Throttle Epochs**: 66

### shock_low_pressure_low_support_high
- **Classification**: stressed
- **Final AR Ratio**: 0.70
- **Max Settlement Queue (Z1U)**: 3,540,628
- **Throttle Epochs**: 0

### shock_low_pressure_base_support_low
- **Classification**: collapse
- **Final AR Ratio**: 0.00
- **Max Settlement Queue (Z1U)**: 4,116,200
- **Throttle Epochs**: 75

### shock_low_pressure_base_support_base
- **Classification**: collapse
- **Final AR Ratio**: 0.01
- **Max Settlement Queue (Z1U)**: 3,459,151
- **Throttle Epochs**: 68

### shock_low_pressure_base_support_high
- **Classification**: stressed
- **Final AR Ratio**: 0.75
- **Max Settlement Queue (Z1U)**: 3,863,380
- **Throttle Epochs**: 0

### shock_low_pressure_high_support_low
- **Classification**: collapse
- **Final AR Ratio**: 0.00
- **Max Settlement Queue (Z1U)**: 7,094,836
- **Throttle Epochs**: 76

### shock_low_pressure_high_support_base
- **Classification**: collapse
- **Final AR Ratio**: 0.01
- **Max Settlement Queue (Z1U)**: 6,596,870
- **Throttle Epochs**: 69

### shock_low_pressure_high_support_high
- **Classification**: stressed
- **Final AR Ratio**: 0.90
- **Max Settlement Queue (Z1U)**: 8,560,337
- **Throttle Epochs**: 0

### shock_base_pressure_low_support_low
- **Classification**: collapse
- **Final AR Ratio**: 0.00
- **Max Settlement Queue (Z1U)**: 9,530,612
- **Throttle Epochs**: 75

### shock_base_pressure_low_support_base
- **Classification**: collapse
- **Final AR Ratio**: 0.01
- **Max Settlement Queue (Z1U)**: 9,191,299
- **Throttle Epochs**: 68

### shock_base_pressure_low_support_high
- **Classification**: stressed
- **Final AR Ratio**: 0.60
- **Max Settlement Queue (Z1U)**: 11,962,285
- **Throttle Epochs**: 0

### shock_base_pressure_base_support_low
- **Classification**: collapse
- **Final AR Ratio**: 0.00
- **Max Settlement Queue (Z1U)**: 9,828,411
- **Throttle Epochs**: 76

### shock_base_pressure_base_support_base
- **Classification**: collapse
- **Final AR Ratio**: 0.01
- **Max Settlement Queue (Z1U)**: 9,489,487
- **Throttle Epochs**: 69

### shock_base_pressure_base_support_high
- **Classification**: stressed
- **Final AR Ratio**: 0.70
- **Max Settlement Queue (Z1U)**: 12,709,856
- **Throttle Epochs**: 0

### shock_base_pressure_high_support_low
- **Classification**: collapse
- **Final AR Ratio**: 0.00
- **Max Settlement Queue (Z1U)**: 15,876,421
- **Throttle Epochs**: 76

### shock_base_pressure_high_support_base
- **Classification**: collapse
- **Final AR Ratio**: 0.01
- **Max Settlement Queue (Z1U)**: 15,855,558
- **Throttle Epochs**: 69

### shock_base_pressure_high_support_high
- **Classification**: stressed
- **Final AR Ratio**: 0.70
- **Max Settlement Queue (Z1U)**: 22,170,673
- **Throttle Epochs**: 0

### shock_high_pressure_low_support_low
- **Classification**: collapse
- **Final AR Ratio**: 0.00
- **Max Settlement Queue (Z1U)**: 14,283,963
- **Throttle Epochs**: 76

### shock_high_pressure_low_support_base
- **Classification**: collapse
- **Final AR Ratio**: 0.01
- **Max Settlement Queue (Z1U)**: 14,217,145
- **Throttle Epochs**: 69

### shock_high_pressure_low_support_high
- **Classification**: stressed
- **Final AR Ratio**: 0.70
- **Max Settlement Queue (Z1U)**: 19,372,730
- **Throttle Epochs**: 0

### shock_high_pressure_base_support_low
- **Classification**: collapse
- **Final AR Ratio**: 0.00
- **Max Settlement Queue (Z1U)**: 14,801,384
- **Throttle Epochs**: 76

### shock_high_pressure_base_support_base
- **Classification**: collapse
- **Final AR Ratio**: 0.01
- **Max Settlement Queue (Z1U)**: 14,735,002
- **Throttle Epochs**: 69

### shock_high_pressure_base_support_high
- **Classification**: stressed
- **Final AR Ratio**: 1.00
- **Max Settlement Queue (Z1U)**: 20,396,635
- **Throttle Epochs**: 0

### shock_high_pressure_high_support_low
- **Classification**: collapse
- **Final AR Ratio**: 0.00
- **Max Settlement Queue (Z1U)**: 23,431,482
- **Throttle Epochs**: 76

### shock_high_pressure_high_support_base
- **Classification**: collapse
- **Final AR Ratio**: 0.01
- **Max Settlement Queue (Z1U)**: 23,819,400
- **Throttle Epochs**: 69

### shock_high_pressure_high_support_high
- **Classification**: stressed
- **Final AR Ratio**: 0.65
- **Max Settlement Queue (Z1U)**: 33,892,308
- **Throttle Epochs**: 0


## 10. Known limitations
M1 tests structure, not final calibration. Results depend on provisional parameter guesses and a non-exogenous price. 

## 11. Recommended M2 extensions
Endogenous pricing, detailed campaign pools, and adversarial agent behavior.
