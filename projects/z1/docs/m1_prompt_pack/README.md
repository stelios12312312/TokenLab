# Z1 TokenLab Prompt Pack — Milestone 1 Only

This pack is for building **Milestone 1: Core Solvency Model** for the Z1 economic simulation inside TokenLab.

The goal is deliberately narrow:

> Test whether the core Z1 loop can survive: **ACR issuance → vesting → settlement through Audience Reserve → utility spend → Treasury fee/burn → Treasury top-up of Audience Reserve**.

Milestone 1 answers only:

- **Q1:** Can the Audience Reserve sustain settlement obligations?
- **Q2:** How does vesting create settlement pressure?
- **Structural Q4:** Does the basic Treasury / AR loop remain solvent?

Milestone 1 does **not** implement:

- endogenous market price
- adversarial rush agents
- creators / validators / brands as full cohorts
- full campaign lifecycle
- governance / delegation
- campaign escrows
- prediction markets
- full 14-agent taxonomy
- 67-parameter sensitivity

Use these prompts sequentially in Cursor, Codex, or another AI coding assistant. Each prompt is written to be copy-pasted directly.

## Recommended order

1. `00_m1_master_context.md`
2. `01_repo_orientation_m1.md`
3. `02_scaffold_m1.md`
4. `03_state_config_cohorts_m1.md`
5. `04_ledger_invariants_m1.md`
6. `05_epoch_loop_m1.md`
7. `06_scenarios_m1.md`
8. `07_stress_grid_m1.md`
9. `08_metrics_outputs_m1.md`
10. `09_plots_m1.md`
11. `10_sensitivity_m1.md`
12. `11_m1_report_generator.md`
13. `12_scope_guardrails_m1.md`

`ALL_M1_PROMPTS_COMBINED.md` contains everything in one file.

## Core rule

Before adding any new abstraction, ask:

> “Does this help answer AR/Treasury solvency in M1?”

If no, defer it.
