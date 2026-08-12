# Red Team Audit Findings

## GitHub cleanup follow-up — 2026-08-12

- **Coverage**: working tree for Program ticket `T-INTAKE-5E47CAAF` / issue #18 on base `85e02f1`.
- **Adversarial objective**: make cleanup appear successful while deleting history, hiding intentional artifacts, documenting a nonexistent command, or calling GitHub green despite a failing external status.
- **Attacks exercised**: tracked-file census, synthetic ignore probe, historical-bundle preservation check, documented Python 3.10 runner smoke, repository metadata readback, Actions/combined-status comparison, full baseline regression, and annotation validation.
- **Evidence**: no `.DS_Store` remains in the index; 37 historical dated files remain tracked; 14 focused tests pass; the supported suite grows from 141/128 passing to 143/130 passing with zero failures; the runner publishes 3,000 result rows and 60 summary rows; GitHub metadata readback matches the README.
- **False-green disposition**: repository-owned Actions pass on the base commit, while combined status remains red solely because of legacy GitBook. The governance note reports both facts and no integration was deleted.
- **New findings**: none at MEDIUM or above in the cleanup boundary. The current runner's 3,027-line console output remains a known demo-quality gap assigned to issue #19; it does not invalidate the generated artifact bundle.
- **Substrate note**: project health reports 0 failures and 109 warnings, dominated by pre-existing planner/documentation references outside this ticket. They are not hidden or reclassified as cleanup success.
- **Confidence**: PASS for repository hygiene, command truthfulness, history preservation, remote metadata, a clean-clone smoke, and both repository-owned PR Actions workflows on PR #21.

## Index
- F-001: Settlement Velocity parameter mismatch (RESOLVED)
- F-002: Tier Settlement Modifiers bonus mismatch (RESOLVED)
- F-003: Vesting Extension factor mismatch & dead parameter (RESOLVED)
- F-004: AMM Peg Defense Failure & virtual loop (RESOLVED)
- F-005: NameError and signature mismatch in SupplyStakerLockup (CRITICAL - RESOLVED)
- F-006: Missing test coverage for SupplyStakerLockup and Apiz simulation (HIGH - RESOLVED)
- F-007: Sign-flip logic error in SupplyStakerLockup and SupplyStakerMonthly execute methods (CRITICAL - RESOLVED)

## Substrate Risks
- No significant substrate risks detected. The story registry (`story_registry.json`) is structurally valid.

---

## Runtime / Code Findings

### F-001: Settlement Velocity parameter mismatch (velocity_scale = 0.1 vs 1.0)
- **Severity**: HIGH
- **Status**: **RESOLVED**
- **File(s)**: [config.py](file:///Users/stylianoskampakis/Dropbox%20(Personal)/Freelance/TokenLab/projects/z1/m3_full_economy/config.py)
- **Line(s)**: 64
- **Verification**: `velocity_scale` is now correctly set to `1.0` in the codebase config.

### F-002: Tier Settlement Modifiers bonus mismatch (1.05/1.10/1.15 vs 1.1/1.2/1.3)
- **Severity**: HIGH
- **Status**: **RESOLVED**
- **File(s)**: [config.py](file:///Users/stylianoskampakis/Dropbox%20(Personal)/Freelance/TokenLab/projects/z1/m3_full_economy/config.py)
- **Line(s)**: 67-69
- **Verification**: Modifiers correctly set to `{"Bronze": 1.0, "Silver": 1.10, "Gold": 1.20, "Platinum": 1.30}` in the config.

### F-003: Vesting Extension factor mismatch (2.0 vs 0.10)
- **Severity**: MEDIUM
- **Status**: **RESOLVED**
- **File(s)**: [config.py](file:///Users/stylianoskampakis/Dropbox%20(Personal)/Freelance/TokenLab/projects/z1/m3_full_economy/config.py)
- **Line(s)**: 103
- **Verification**: Updated to `0.10` and correctly integrated into the simulation logic under stressed epochs.

### F-004: AMM Peg Defense Failure (target_reserves logic and surplus perpetual loop)
- **Severity**: CRITICAL
- **Status**: **RESOLVED**
- **File(s)**: [economy.py](file:///Users/stylianoskampakis/Dropbox%20(Personal)/Freelance/TokenLab/projects/z1/m3_full_economy/economy.py)
- **Line(s)**: 353-367
- **Verification**: Peg defense now bases target reserves on initial reserves (`self.config.treasury_initial * self.config.treasury_topup_target_ratio`), includes the `spot_price < initial_spot_price` floor check, and correctly avoids the infinite virtual USD loop.

### F-005: NameError and signature mismatch in SupplyStakerLockup (CRITICAL - RESOLVED)
- **Severity**: CRITICAL
- **Category**: Business Logic Correctness / Runtime Error
- **File(s)**: [supplyclasses.py](file:///Users/stylianoskampakis/Dropbox%20(Personal)/Freelance/TokenLab/src/TokenLab/simulationcomponents/supplyclasses.py)
- **Line(s)**: 258-317
- **Description**: The `SupplyStakerLockup` class contained multiple fatal runtime errors:
  1. The `__init__` constructor called `super()` with positional arguments mapping `quit_prob` incorrectly, and lacked setting `self.staking_amount = staking_amount`.
  2. Inside `execute()`, unqualified calls to `get_linked_agentpool()` crashed under standalone configurations.
- **Impact**: Any simulation using `SupplyStakerLockup` crashed immediately upon instantiation.
- **Resolution**: Aligned child and super constructors to use explicit keyword arguments, bound the public `staking_amount` field, and qualified all sibling method lookups.

### F-006: Missing test coverage for SupplyStakerLockup and Apiz simulation (HIGH - RESOLVED)
- **Severity**: HIGH
- **Category**: Code Architecture / Test Coverage Gaps
- **File(s)**: [tests/](file:///Users/stylianoskampakis/Dropbox%20(Personal)/Freelance/TokenLab/tests/)
- **Description**: Staking components and the `apiz.py` simulation were completely unexercised by the test suites.
- **Resolution**: Appended a test case `test_supply_staker_lockup` to the unit tests, and verified execution of `apiz.py` with custom relative-path overrides.

### F-007: Sign-flip logic error in SupplyStakerLockup and SupplyStakerMonthly execute methods (CRITICAL - RESOLVED)
- **Severity**: CRITICAL
- **Category**: Mathematical / Tokenomics Logic Error
- **File(s)**: [supplyclasses.py](file:///Users/stylianoskampakis/Dropbox%20(Personal)/Freelance/TokenLab/src/TokenLab/simulationcomponents/supplyclasses.py)
- **Line(s)**: 290-387
- **Description**: Staking operations incorrectly set `self._staking_amount` to a negative value at iteration 0:
  *   This caused future rewards/unlocks calculations to multiply by a negative base, flipping the signs of all subsequent payouts.
  *   With `self.source = None`, lockup unlocks and monthly rewards *decreased* circulating supply further instead of increasing it.
  *   With `self.source = treasury`, initial lockups *retrieved* tokens from the treasury (decreasing it) and *increased* circulation immediately, while unlocking further depleted treasury reserves.
- **Impact**: The staking mechanism functioned completely in reverse, draining circulating supply during unlocks/payouts and acting as a treasury withdrawer.
- **Resolution**: Refactored `execute()` methods to preserve absolute staking values (`self._staking_amount = staked` as positive), and added conditional bounds to direct initial locks (`value < 0`) into the treasury vault as deposits (`value = -value`) and unlocks/payouts (`value > 0`) out of the treasury as withdrawals.

---

## Formal / Ontology Findings
- None. The Prolog invariants passed successfully.
