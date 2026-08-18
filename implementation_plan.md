# TokenLab Monte Carlo and Agentic Foundation — Corrective Plan

The canonical working plan is [`plans/plan_2026-08-16_4c55a1a347b5e818/plan.md`](plans/plan_2026-08-16_4c55a1a347b5e818/plan.md). This document is the concise review handoff.

## What is being corrected

The current gallery is functional software, but its flagship scenario is deterministic: four repetitions of the same path, no uncertain parameter distributions, and no usable confidence-interval evidence. The runner also wraps stochastic components that derive seeds from wall-clock time, so its reproducibility contract does not yet generalize to real stochastic models. Finally, the “agentic” layer can safely orchestrate scenarios but cannot inspect, challenge, or refuse unsupported assumptions.

## Correct order of work

1. **Repair product contracts:** create a corrective Program ticket/story, add Monte Carlo acceptance criteria, restore the missing agent story, and block historical demo migrations on the new foundation.
2. **Fix RNG ownership:** replace time/global randomness with explicit per-path and per-component generators and stable seed lineage.
3. **Add uncertainty schema v2:** fixed versus uncertain inputs, named distribution parameters, bounds, units, cadence, provenance, calibration/approval status, and explicit dependence.
4. **Add ensemble/statistical artifacts:** raw paths, parameter samples, quantiles, modeled outcome intervals, estimator confidence intervals, convergence, sensitivity, path failures, and manifest lineage.
5. **Add assumption-aware agent operations:** inspect, validate, propose, run, and summarize; draft or unsupported priors remain non-executable.
6. **Make the dashboard scientifically useful:** keep the deterministic explorer as a control and add one real stochastic demo with fan chart, histogram, CI, sensitivity, convergence, assumptions, provenance, and failure states.
7. **Migrate historical projects only after proof:** demand → vesting/unlocks → Z1 treasury → staking/multi-token, one child plan and parity contract each.

## Initial demo contract

The first stochastic demo uses exactly three illustrative triangular uncertainties derived from the existing downside/baseline/upside presets:

| Parameter | Min | Mode | Max |
|---|---:|---:|---:|
| User ceiling | 12,000 | 20,000 | 32,000 |
| Ending transaction value | 80 | 120 | 180 |
| Holding time | 0.75 | 1.5 | 2.5 |

They are explicitly independent, uncalibrated, and illustrative. Fixed supply remains 250,000,000 TLAB; emissions, vesting, liquidity, treasury, governance, staking, FDV, and APY are explicitly absent.

Run tiers are 100 paths (fast demo), 500 (standard), and 2,000 (deep), with 500/2,000/5,000 deterministic bootstrap resamples. These numbers are provisional until the first supported-Python benchmark, but any revision must be documented before interpreting results.

## Scientific acceptance gates

- Same config/seed/path budget produces identical parameter samples and content hashes.
- No time-derived seed or process-global RNG remains in scientific paths.
- A stochastic demo has approved uncertainty and nonzero dispersion; the deterministic control cannot pass that gate.
- P10–P90 is labeled a modeled outcome interval, not a confidence interval.
- A 95% confidence interval names the estimator and method; binary probabilities use Wilson intervals.
- Completed/failed counts and convergence status appear in artifacts and UI.
- Sensitivity reports sample count, uncertainty, constant/insufficient states, and a non-causal boundary.
- Schema v1, legacy dashboard/CLI, installed package behavior, and Z1 golden parity remain green.
- Agents refuse draft, missing, or unsupported assumptions instead of silently inventing priors.
- Desktop and narrow browser journeys exercise the real runner and all success/error states.

## Required tests

New suites: `test_uncertainty_schema.py`, `test_rng_reproducibility.py`, `test_monte_carlo_runner.py`, `test_statistical_artifacts.py`, and `test_agentic_assumptions.py`.

Updated suites: `test_agentic_runner.py`, `test_public_demo.py`, `test_demo_gallery.py`, `test_dashboard.py`, and the maintained Z1 parity/stochastic/risk suites. The final gate also requires the full supported-Python suite, installed-wheel smoke, immutable artifact review, and rendered browser evidence at 1440×1000 and 390×844.

## Execution boundary

Use `/safe-change-power`, with a stop gate and independent commit after each foundation phase. Do not start historical migrations until the canonical stochastic demo passes all scientific, compatibility, security, and UX gates. No product code was changed while producing this plan.

