# Gotchas

Non-obvious traps and constraints. Format: `G-NNN: Short title (date)`.

<!-- Next gotcha: G-002 -->

## G-001: Infinite buyback loop when spot price peg check is missing (2026-06-19)
- **Trigger**: Setting up treasury-driven buybacks with a fixed reserve target check but without verifying if the spot price is actually below the peg (initial spot price).
- **Fix**: Always restrict AMM buyback actions with a price check `spot_price < initial_spot_price` to prevent artificial virtual price inflation loops (e.g. driving spot price to $14,000+).
