# Red Team Audit Regression Tests

This document defines regression tests that prevent the recurrence of identified findings.

## RT-001: Verification of Spec-Aligned Defaults (F-001, F-002, F-003) (RESOLVED)
- **Objective**: Assert that default config parameters match designed specification values.
- **Test Case**: See `tests/test_tokenomics_compliance.py`.

## RT-002: Treasury Buyback Target reserves scaling (F-004) (RESOLVED)
- **Objective**: Verify that the treasury buyback target reserves is a constant proportion of the initial treasury balance and does not scale with live supply.
- **Test Case**: Verify parameter locks output.

## RT-003: Price Floor Peg Defense Trigger (F-004) (RESOLVED)
- **Objective**: Assert that buybacks are only executed when the spot price is below the initial peg price ($0.10).
- **Test Case**: Verify target reserve buybacks.

## RT-004: Staker Class Instantiation and Constructor Validation (F-005 - RESOLVED)
- **Objective**: Assert that `SupplyStakerLockup` and `SupplyStakerMonthly` instantiate correctly without NameError and map the constructor parameters to correct attributes.
- **Test Case**:
  ```python
  def test_supply_staker_lockup_instantiation():
      from TokenLab.simulationcomponents.supplyclasses import SupplyStakerLockup
      staker = SupplyStakerLockup(staking_amount=10000.0, rewards=0.05, lockup_duration=12, quit_prob=0.01)
      assert staker.lockup_duration == 12
      assert staker._quit_prob == 0.01
  ```

## RT-005: Staker Sign-Flip Prevention (F-007 - RESOLVED)
- **Objective**: Assert that the staked amount remains stored as a positive absolute value, and unlocks/monthly payouts return positive supply values.
- **Test Case**:
  ```python
  def test_supply_staker_sign_transitions():
      from TokenLab.simulationcomponents.supplyclasses import SupplyStakerLockup
      staker = SupplyStakerLockup(staking_amount=10000.0, rewards=0.05, lockup_duration=3, quit_prob=0.0)
      
      # Epoch 0 (Staking begins)
      staker.execute()
      assert staker.get_supply() == -10000.0
      assert staker._staking_amount == 10000.0
      
      # Epoch 1 & 2 (Locked)
      staker.execute()
      assert staker.get_supply() == 0.0
      staker.execute()
      assert staker.get_supply() == 0.0
      
      # Epoch 3 (Lockup ends, unlocks + reward)
      staker.execute()
      assert staker.get_supply() == 10500.0
  ```
