# Validate Checklist

Canonical authoring checklist for the VALIDATE phase. Use this after REFLECT to finalize proof before CLOSE.

## Validation Pass

- [ ] Read `verification_strategy.yaml`, `reflection.md`, and `verification.md`
- [ ] Run full test suite when the slice has one; otherwise run the strongest planned validation bundle for the chosen task profile
- [ ] Verify every criterion in `verification_strategy.yaml` against actual evidence
- [ ] Keep `## Systems Exercised`, `## Remaining Unverified`, and `## Verification Sufficiency` honest
- [ ] Keep `## Proof of Work` backed by real command output or the explicit `UNVERIFIED: Requires manual user validation` marker
- [ ] Keep `## Test Drift Scan`, `## Regression Audit`, and `## Learned Obligations` truthful for the current slice
- [ ] If planner-core files changed, record the required planner-on-planner proof bundle
- [ ] If active mistake hooks or remediation guards apply, record the required evidence or approved waivers
- [ ] Finalize `verification.md` as the close-facing proof surface
- [ ] Run the `validate-to-close` gate

## Current Compatibility Note

- `validate-to-close` still enforces the current gate-backed proof contracts rather than this simplified checklist alone
- Keep any runtime-required sections, planner-core proof, persona-audit evidence, and reachability-facing proof truthful until later gate simplification lands
