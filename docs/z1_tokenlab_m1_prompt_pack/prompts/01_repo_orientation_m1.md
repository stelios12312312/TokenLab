# Prompt 01 — Repo Orientation and M1 Implementation Plan

```text
You are working inside the TokenLab codebase.

Goal:
Implement the Z1 Phase 3 Milestone 1 Core Solvency Model as a TokenLab-native example/model.

Before writing code:
1. Inspect the existing TokenLab repo structure.
2. Identify where examples/models live.
3. Identify existing abstractions for agents/cohorts, simulation loops, controllers, scenarios, observers, configs, plotting, and reports.
4. Propose the smallest implementation that reuses TokenLab patterns.
5. Do not create a separate framework unless absolutely required.

M1 target questions:
- Q1: Can the Audience Reserve sustain settlement obligations?
- Q2: How does vesting create settlement pressure?
- Structural Q4: Does the basic Treasury/AR loop remain solvent?

M1 model scope:
- 3 cohorts: passive_viewers, active_viewers, power_users
- reduced-form claims and verification
- ACR issuance and vesting
- settlement through Audience Reserve with cap and queue
- utility spend split into provider/Treasury/burn
- exogenous brand inflow into Treasury
- Treasury top-up of AR
- health throttle
- invariant checks
- baseline, collapse, stable scenarios
- 27-scenario stress grid
- static plots and report

Do not implement code in this prompt.

Deliverable:
Return a concise implementation plan with:
- files to create/modify
- TokenLab abstractions to reuse
- proposed module structure
- implementation order
- test strategy
- explicit deferred scope
```
