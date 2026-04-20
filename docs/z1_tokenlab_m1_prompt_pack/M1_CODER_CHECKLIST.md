# M1 Coder Checklist

## Build order

- [ ] Repo orientation complete
- [ ] Scaffold created
- [ ] Config validation implemented
- [ ] Initial state construction implemented
- [ ] Cohorts implemented
- [ ] Ledger functions implemented
- [ ] Invariant checks implemented
- [ ] Five-step epoch loop implemented
- [ ] Baseline scenario runs
- [ ] Collapse scenario runs
- [ ] Stable scenario runs
- [ ] 27-scenario grid runs
- [ ] Metrics saved to CSV
- [ ] Summaries saved to JSON
- [ ] Static plots generated
- [ ] Sensitivity screening runs
- [ ] M1 report generated
- [ ] Scope audit passes

## Must-have tests

- [ ] invalid config fails
- [ ] one epoch runs
- [ ] 104 epochs run
- [ ] seed reproducibility
- [ ] settlement cannot overdraw AR
- [ ] utility spend cannot overdraw cohort balance
- [ ] ACR conservation holds
- [ ] Z1U flow accounting holds
- [ ] queue consistency holds
- [ ] baseline has no invariant failures
- [ ] 27 scenarios generated
- [ ] scenario classification exists

## Exit criterion

M1 is complete when the model can show both:

1. A collapse/stress case where extraction outpaces recapture.
2. A stable case where spending/inflows/top-ups keep AR healthier.

If the model cannot show both, it is not useful yet.
