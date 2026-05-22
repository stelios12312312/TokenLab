# M1 Acceptance Criteria

The M1 build is complete only when all of the following are true.

## Functional

- A baseline scenario runs for 104 epochs without invariant failure.
- A collapse scenario produces visible AR/Treasury stress.
- A stable scenario produces a healthier AR/Treasury path.
- The 27-scenario stress grid runs and classifies each scenario as stable, stressed, or collapse.
- All randomness is seedable and reproducible.
- All core outputs are saved to CSV/JSON.
- A human-readable `M1_report.md` is generated.

## Accounting

- No balance can go negative.
- Settlement never overdraws the Audience Reserve.
- ACR conservation holds every epoch.
- Z1U flow accounting reconciles every epoch.
- Burn accounting reconciles every epoch.
- Queue accounting is consistent.
- AR floor breaches are visible as metrics.

## Scope control

- No endogenous market price in M1.
- No governance in M1.
- No creators/validators/campaign lifecycle in M1.
- No full 14-agent taxonomy in M1.
- No complex PCS weighting in M1.

## Human review

The final M1 report must clearly state:

> “M1 is a directional solvency model. It tests core structure, not final calibration.”
