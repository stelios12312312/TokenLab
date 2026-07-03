# Red Team Audit Anti-Patterns

## AP-001: Mismatched Default Configuration Values (RESOLVED)
- **Pattern**: Configuration parameters defined in code diverge from the designed tokenomics narrative or specification values.
- **Example**: `velocity_scale: float = 0.1` instead of `1.0`.
- **Grep Signature**: `velocity_scale\s*:\s*float\s*=\s*0\.1`
- **Mitigation**: Double-check all configured defaults against the spec in a formal parameter-locks verification matrix.

## AP-002: Target Reserves calculated using Live Supply instead of Base Reserves (RESOLVED)
- **Pattern**: A cohort pool's buyback target reserves is calculated using the total circulating/live supply of the entire system instead of the cohort's own base or initial size, rendering the target unattainable.
- **Example**: `target_reserves = current_live_supply * self.config.treasury_topup_target_ratio` (where supply is 30M and treasury is 2.5M).
- **Grep Signature**: `target_reserves\s*=\s*current_live_supply`
- **Mitigation**: Express targets as a function of the cohort's own initial/maximum reserves, or use a fixed parameter ceiling.

## AP-003: Uncapped Virtual Currency Loops (RESOLVED)
- **Pattern**: Buying back tokens on an AMM using a virtual fiat currency budget calculated dynamically from a circulating token surplus, without tracking or enforcing a finite treasury cash limit, creating a perpetual virtual injection loop.
- **Example**: `usd_to_spend = (surplus * buyback_ratio) * self.amm.spot_price` without checking if the spot price is below the peg or if the treasury actually has that USD balance.
- **Grep Signature**: `usd_to_spend\s*=\s*\(surplus\s*\*\s*buyback_ratio\)`
- **Mitigation**: Restrict buybacks to price-stabilization events (spot price < initial price) and enforce hard ceilings on virtual currency generation.

## AP-004: Dead Configuration Parameters (RESOLVED)
- **Pattern**: Configuration parameters are declared in config schemas but are completely ignored/bypassed in the active business logic loops.
- **Example**: `vesting_extension_factor` defined in config but never applied in `ledger.py` or `economy.py`.
- **Grep Signature**: `vesting_extension_factor` (only found in `config.py` declaration)
- **Mitigation**: Write active check invariants or story coverage requirements that test dynamic parameter activation under stress.

## AP-005: Unqualified Method Calls and Missing Parameters in Constructors (RESOLVED)
- **Pattern**: Calling superclass or sibling methods without qualifying them with `self.`, or referencing variables in superclass initializers that are not passed into the child constructor, resulting in fatal runtime `NameError` exceptions.
- **Example**: Calling `get_linked_agentpool()` directly instead of `self.get_linked_agentpool()`, or calling `super().__init__(..., quit_prob=quit_prob)` where `quit_prob` is not a parameter.
- **Grep Signature**: `get_linked_agentpool\(\)` (matches unqualified calls in simulationcomponents)
- **Mitigation**: Always qualify helper/method calls on classes with `self.` or `super().`, and ensure all referenced parameters are explicitly accepted in constructor signatures.

## AP-006: Internal Sign Storing Mismatch (CRITICAL - NEW)
- **Pattern**: Storing negative state changes (e.g. `value = -1 * base`) into a state attribute (like `self._staking_amount = value`) that is later used as a positive base for calculations (such as rewards or unlocks), causing subsequent outputs to flip signs and compound errors.
- **Example**: `self._staking_amount = value` (where value is negative) followed by `value = self._staking_amount * reward`.
- **Mitigation**: Always store absolute balances/sizes as positive values, and only apply direction signs dynamically during deposit or retrieval actions.
