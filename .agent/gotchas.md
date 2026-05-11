# TokenLab Gotchas & Lessons Learned

## Silent Fallbacks in Metrics Extraction
**Date:** 2026-05-10
**Context:** Extracting `z1u_price` in `TokenLab/examples/z1_m2_market_dynamics/metrics.py`.
**Issue:** Using `getattr(state.amm, 'price', 1.0)` silently masked a critical pricing failure in the simulation output. The actual property was `spot_price`. Because `getattr` was provided a default value of `1.0`, the simulation output printed `$1.0000` for all epochs, leading to a false assumption of "Price Invariance" under heavy market dumping.
**Lesson:** Do not use `getattr` with default fallbacks for critical simulation metrics unless the absence of the object is an expected scenario. If the attribute name is wrong, it will fail silently and corrupt the simulation reports. Instead, rely on direct property access (e.g. `state.amm.spot_price` if `hasattr(state, 'amm') else 1.0`) which will correctly throw an `AttributeError` if the property name changes or is incorrect.
