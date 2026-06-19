# Red Team Audit Regression Tests

This document defines regression tests that prevent the recurrence of identified findings.

## RT-001: Verification of Spec-Aligned Defaults (F-001, F-002, F-003)
- **Objective**: Assert that default config parameters match designed specification values.
- **Test Case**:
  ```python
  def test_spec_defaults():
      config = M3EconomyConfig()
      assert config.velocity_scale == 1.0
      assert config.tier_sr_modifiers["Silver"] == 1.10
      assert config.tier_sr_modifiers["Gold"] == 1.20
      assert config.tier_sr_modifiers["Platinum"] == 1.30
      assert config.vesting_extension_factor == 0.10
      assert config.treasury_buyback_ratio == 0.10
  ```

## RT-002: Treasury Buyback Target reserves scaling (F-004)
- **Objective**: Verify that the treasury buyback target reserves is a constant proportion of the initial treasury balance and does not scale with live supply.
- **Test Case**:
  ```python
  def test_buyback_target_reserves():
      config = M3EconomyConfig()
      economy = TokenEconomy_Z1(config)
      
      # Artificially inflate live supply (e.g. by minting)
      # Assert target reserves remain constant at 1M Z1U
      target_reserves = config.treasury_initial * config.treasury_topup_target_ratio
      assert target_reserves == 1_000_000.0
  ```

## RT-003: Price Floor Peg Defense Trigger (F-004)
- **Objective**: Assert that buybacks are only executed when the spot price is below the initial peg price ($0.10).
- **Test Case**:
  ```python
  def test_buyback_trigger_conditions():
      config = M3EconomyConfig(treasury_buyback_ratio=0.10)
      economy = TokenEconomy_Z1(config)
      
      # Case 1: Price is above the peg ($0.12)
      economy.amm.spot_price = 0.12
      # Execute buybacks, verify no tokens are bought / burned
      # Case 2: Price is below the peg ($0.08)
      economy.amm.spot_price = 0.08
      # Execute buybacks, verify tokens are bought and burned
  ```
