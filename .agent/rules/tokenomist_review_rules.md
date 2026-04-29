# Tokenomist Review Rules — TokenLab Agent Standard

## Purpose

These rules codify the structural review checks that any tokenomist (human or AI agent) MUST perform when designing, calibrating, or reviewing a token economy model. They are derived from hard-won simulation evidence (Z1 M1, 27-scenario stress grids) and formalize the patterns that separate stable economies from collapsing ones.

> **IMPORTANT**: These rules apply to ALL TokenLab simulation models, not just Z1. Adapt the specific formulas to the model's architecture, but the principles are universal.

---

## 1. Parameter Lock Discipline

### Rule: Every model MUST define explicit parameter locks

A **parameter lock** is a structural constraint between two or more parameters that, if violated, predicts system failure. Locks are discovered through simulation evidence, not theoretical intuition.

**Two lock types:**

| Type | Meaning | When to Use |
|------|---------|-------------|
| **HARD** | Violation → collapse in 100% of observed simulations | Non-negotiable. Block or warn loudly. |
| **SOFT** | Violation → fragility; survivable only with compensating parameters | Advisory. Flag for tokenomist review. |

**Agent behavior:**
- When creating or modifying a `config` dataclass, ALWAYS implement `check_solvency_locks()` or equivalent
- HARD lock violations MUST print `❌` warnings to console during simulation runs
- SOFT lock violations MUST print `⚠️` advisory messages
- All lock checks MUST appear in the HTML report

### Canonical Pattern (from Z1 M1):

```python
def check_solvency_locks(self) -> list[dict]:
    diagnostics = []
    diagnostics.append({
        'lock': 'L1', 'severity': 'HARD', 'status': 'PASS|FAIL|WARN',
        'message': '...', 'value': x, 'threshold': y,
    })
    return diagnostics
```

---

## 2. The Master Solvency Invariant

### Rule: Every token economy MUST have a single, dominant ratio that predicts survival

For any model, identify the one ratio that most cleanly separates stable from collapsing outcomes. This is discovered empirically — run the stress grid, then compute which single metric has the highest classification accuracy.

**Generic form:**
```
                    Σ(extraction_pressures)
Solvency Ratio = ─────────────────────────────
                    Σ(recapture_mechanisms)
```

**Threshold calibration:**
- Run the full stress grid (27+ scenarios minimum)
- Compute the ratio for each scenario
- Find the threshold where classification accuracy is maximized
- Expect: ratio < threshold → stable, ratio > threshold → collapse

**Z1 M1 example:**
```
Solvency Ratio = (Σ claim_rates × Σ settle_propensity × settlement_ratio) / (Σ spend_rates × fee_share + brand_inflow/AR)
Threshold: 0.8 (stable below, collapse above)
```

---

## 3. Per-Cohort Net-Drain Analysis

### Rule: For EVERY cohort, check whether it is a net contributor or net extractor

A cohort is a **net extractor** if it removes more value from the system than it returns. This is the most common source of hidden insolvency.

**Formula:**
```
Net Drain = settle_propensity[cohort] / utility_spend_rate[cohort]

If Net Drain > 0.5  → cohort is a net extractor
If Net Drain ≤ 0.5  → cohort is a net contributor
```

**Agent behavior:**
- ALWAYS compute and display net-drain per cohort in reports
- Flag any cohort with Net Drain > 0.5 as `⚠️ NET EXTRACTOR`
- A system can survive with net-extractor cohorts ONLY if the remaining cohorts generate enough surplus
- Passive/free-tier cohorts are the most common net extractors — this is a design choice, not a bug, but it MUST be conscious

---

## 4. Stress Grid Classification

### Rule: Every model MUST produce a mix of outcomes across its stress grid

If the stress grid produces:
- **ALL stable** → grid is too narrow; widen parameter ranges toward failure
- **ALL collapse** → defaults are too aggressive; rebalance baseline
- **No stable** → same as above; the baseline should be near the stability boundary

**Target distribution:**
```
Healthy grid: ~50% collapse, ~20-30% stressed, ~20-30% stable
```

This ensures the model is testing the right parameter space and the boundary is visible.

**Agent behavior:**
- After running a grid, count outcomes by classification
- If distribution is heavily skewed (>80% one class), recommend parameter rebalancing
- The grid MUST cover at least 3 dimensions (e.g., shock × pressure × support)

---

## 5. Confidence Interval Mandate

### Rule: Any report presented to a tokenomist MUST show uncertainty

Single-run deterministic results are misleading. All plots and summary statistics MUST show confidence intervals when presented for review.

**Implementation:**
- Run with `repetitions ≥ 10`
- Apply ±5% parameter jitter per repetition (uniform noise on rates)
- Use seaborn `errorbar=('ci', 95)` for automatic CI bands
- Summary metrics should show median ± IQR across repetitions

**Exception:** Grid sweeps (27+ scenarios) may use `repetitions=1` for speed, since the grid itself provides parameter variation.

---

## 6. Inflow Floor Constraint

### Rule: Every token economy has a minimum viable inflow rate

Below a certain inflow rate, NO parameter combination can save the system. This is a hard floor discovered empirically.

**Discovery process:**
1. Run the stress grid
2. Identify all `support=low` (or equivalent) scenarios
3. If 100% collapse at low support → that inflow level is below the floor
4. The floor is the lowest inflow level where at least one scenario survives

**Agent behavior:**
- ALWAYS report the inflow floor in the parameter locks section
- Express as a percentage of the reserve: `brand_inflow ≥ X% of AR per epoch`
- Flag violations as HARD lock failures

---

## 7. Settlement-Inflow Balance

### Rule: The rate at which value exits the system MUST be bounded by the rate at which value enters

This is a generalization of Z1's Lock 2 (`settlement_ratio ≤ 2 × fee_share`). In any model:

```
max_extraction_rate ≤ K × primary_recapture_rate
```

Where `K` is model-specific (typically 1.5–2.5×, discovered via simulation).

---

## 8. Report Section Requirements

### Rule: Every HTML report MUST include a Parameter Locks section

Minimum contents:
1. **Solvency ratio value** for each scenario (with color-coded interpretation)
2. **Lock check table** — pass/fail for each lock per scenario
3. **Per-cohort net-drain table** — settle/spend ratio for each cohort
4. **Design rules callout** — actionable constraints for the tokenomist

This section should appear AFTER the grid summary and BEFORE sensitivity analysis.

---

## 9. Parameter Change Review Protocol

### Rule: When modifying simulation parameters, ALWAYS re-run lock checks

**Before committing any parameter change:**
1. Run `config.check_solvency_locks()` on the new config
2. Compare lock results before and after
3. If any HARD lock transitions from PASS → FAIL, block the change
4. If any SOFT lock transitions from PASS → WARN, note in commit message

**Agent behavior:**
- After any config modification, print lock diagnostics to console
- Include lock status in the run summary output
- Track lock violations across runs to detect parameter drift

---

## 10. Tokenomist Deliverable Checklist

### Rule: Before declaring any model "ready for review", confirm:

- [ ] Master solvency invariant identified and threshold calibrated
- [ ] Parameter locks defined (minimum: solvency floor + inflow floor)
- [ ] Per-cohort net-drain analysis complete
- [ ] Stress grid run with mixed outcomes (not all-collapse or all-stable)
- [ ] Confidence intervals shown on all plots (repetitions ≥ 10)
- [ ] HTML report includes Parameter Locks section
- [ ] All HARD lock violations explained or resolved
- [ ] Design rules documented in plain English for non-technical stakeholders

---

## Quick Reference: Lock Severity Guide

```
❌ HARD FAIL  → System WILL collapse. Parameter change required.
⚠️ HARD WARN  → System is at boundary. Fragile — proceed with caution.
⚠️ SOFT FAIL  → Design smell. Survivable but creates hidden fragility.
✅ PASS        → Constraint satisfied.
```

---

## Applicability

These rules apply to:
- **Z1 Core Solvency (M1)** — fully implemented
- **Any new TokenLab simulation** — implement the patterns; calibrate thresholds via simulation
- **Client tokenomics reviews** — use the checklist as a review protocol
- **Agent-driven parameter tuning** — enforce locks programmatically before accepting parameter changes
