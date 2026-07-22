% packs/tokenomics/rules.pl - Tokenomics arithmetic and claim invariants.
% Domain-specific facts are asserted by packs/tokenomics/index.mjs. The core
% planner engine remains domain-agnostic.
%
% Numeric cutoffs below are clean-room tolerances chosen for arithmetic sanity, not
% lifted from any external source. All supply/percentage values are in basis points
% (bps; 10000 bps = 100%):
%   9950..10050  (TK-007) allocation sum must land within +/-0.5% of 100% — absorbs
%                rounding across many line items without allowing a real gap.
%   > 200        (TK-009) FDV may differ from price x max-supply by at most 2% before
%                it is treated as an unreconciled claim.
%   >= 3000      (TK-011) a single cliff unlock of >=30% of supply is flagged as
%                concentrated sell-pressure.
%   Hours < 1    (TK-012) an admin-key timelock under one hour offers no practical
%                governance delay and is treated as missing.

tokenomics_violation('TK-007', Plan, 'allocation_sum_invalid: allocation percentages do not sum to roughly 100 percent', 'CRITICAL') :-
    tokenomics_allocation_sum_bps(Plan, Sum),
    Sum < 9950.

tokenomics_violation('TK-007', Plan, 'allocation_sum_invalid: allocation percentages do not sum to roughly 100 percent', 'CRITICAL') :-
    tokenomics_allocation_sum_bps(Plan, Sum),
    Sum > 10050.

tokenomics_violation('TK-008', Plan, 'supply_order_invalid: circulating supply exceeds total supply', 'CRITICAL') :-
    tokenomics_supply(Plan, circulating, Circ),
    tokenomics_supply(Plan, total, Total),
    Circ > Total.

tokenomics_violation('TK-008', Plan, 'supply_order_invalid: total supply exceeds max supply', 'CRITICAL') :-
    tokenomics_supply(Plan, total, Total),
    tokenomics_supply(Plan, max, Max),
    Total > Max.

tokenomics_violation('TK-009', Plan, 'fdv_mismatch: FDV does not reconcile to token price times max supply', 'CRITICAL') :-
    tokenomics_fdv_diff_bps(Plan, Diff),
    Diff > 200.

tokenomics_violation('TK-010', Plan, 'emissions_funded_yield: staking APY depends on scheduled emissions rather than modeled protocol revenue', 'CRITICAL') :-
    tokenomics_apy_bps(Plan, promised, Promised),
    tokenomics_apy_bps(Plan, protocol_revenue, Revenue),
    tokenomics_apy_bps(Plan, scheduled_emissions, Emissions),
    Promised > Revenue,
    Emissions > 0.

tokenomics_violation('TK-010', Plan, 'emissions_funded_yield: staking APY exceeds modeled revenue plus scheduled emissions', 'CRITICAL') :-
    tokenomics_apy_bps(Plan, promised, Promised),
    tokenomics_apy_bps(Plan, protocol_revenue, Revenue),
    tokenomics_apy_bps(Plan, scheduled_emissions, Emissions),
    Covered is Revenue + Emissions,
    Promised > Covered.

tokenomics_violation('TK-011', Plan, 'unlock_cliff_pressure: cliff unlock releases too much supply at once', 'HIGH') :-
    tokenomics_unlock_cliff_bps(Plan, Cliff),
    Cliff >= 3000.

tokenomics_violation('TK-012', Plan, 'governance_timelock_missing: admin key lacks timelock control', 'HIGH') :-
    tokenomics_admin_key(Plan, true),
    \+ tokenomics_timelock_hours(Plan, _).

tokenomics_violation('TK-012', Plan, 'governance_timelock_missing: admin key timelock is too short', 'HIGH') :-
    tokenomics_admin_key(Plan, true),
    tokenomics_timelock_hours(Plan, Hours),
    Hours < 1.

tokenomics_violation('TK-005', Plan, 'guaranteed_roi_claim: tokenomics plan promises buyer ROI or returns', 'CRITICAL') :-
    tokenomics_guaranteed_roi_claim(Plan).

invariant_violated(tokenomics_arithmetic_invalid, Plan) :-
    tokenomics_violation('TK-007', Plan, _, 'CRITICAL').

invariant_violated(tokenomics_arithmetic_invalid, Plan) :-
    tokenomics_violation('TK-008', Plan, _, 'CRITICAL').

invariant_violated(tokenomics_arithmetic_invalid, Plan) :-
    tokenomics_violation('TK-009', Plan, _, 'CRITICAL').

invariant_violated(tokenomics_arithmetic_invalid, Plan) :-
    tokenomics_violation('TK-010', Plan, _, 'CRITICAL').

invariant_violated(tokenomics_claim_boundary_invalid, Plan) :-
    tokenomics_violation('TK-005', Plan, _, 'CRITICAL').
