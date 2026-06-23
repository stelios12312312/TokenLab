# Gotchas

Non-obvious traps and constraints. Format: `G-NNN: Short title (date)`.

<!-- Next gotcha: G-002 -->

## G-001: Infinite buyback loop when spot price peg check is missing (2026-06-19)
- **Trigger**: Setting up treasury-driven buybacks with a fixed reserve target check but without verifying if the spot price is actually below the peg (initial spot price).
- **Fix**: Always restrict AMM buyback actions with a price check `spot_price < initial_spot_price` to prevent artificial virtual price inflation loops (e.g. driving spot price to $14,000+).

## G-002: Dynamic importing of project configs requires absolute sys.path inclusion (2026-06-23)
- **Trigger**: Running compliance tests or verification scripts using dynamic imports (`importlib.import_module`) when the execution directory is not included in `sys.path`.
- **Fix**: Fall back to adding `os.getcwd()` to `sys.path` in the import wrapper to resolve namespaced module imports cleanly, and invoke pytest with `PYTHONPATH=src`.
