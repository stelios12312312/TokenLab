# Browser Journey Verification Report

Date: 2026-08-16 20:20:53

Server: `create_gallery_server` (stdlib http.server, loopback 127.0.0.1),
output dir `scratch/browser_evidence/gallery-runs`.
Browser: Playwright headless Chromium.

| Journey | Assertion | Result | Evidence |
|---|---|---|---|
| desktop | initial load: no console errors | PASS | console clean |
| desktop | initial load: no failed requests | PASS | all responses < 400 |
| desktop | running state reached | PASS | desktop_03_running.png |
| desktop | fast run reached success | PASS | desktop_04_success.png |
| desktop | fan chart legend 'modeled outcomes: P10–P90' | PASS | fan section text |
| desktop | terminal histogram rendered | PASS | histogram-wrap |
| desktop | percentile table rendered | PASS | percentile-table |
| desktop | CI card: '95% percentile-bootstrap confidence interval' | PASS | Terminal modeled token price: 95% percentile-bootstrap confidence interval for the median
0.011 $ per TLAB
median estima |
| desktop | CI card names an estimator | PASS | estimator: median |
| desktop | sensitivity table: 'association is not causal' | PASS | page copy |
| desktop | convergence section populated | PASS | convergence-panel |
| desktop | coverage ledger: supply fixed 250,000,000 TLAB | PASS | SUPPLY — FIXED
Constant supply of 250,000,000 TLAB is configured and held fixed across every path; no mint or burn is modeled.
EMISSIONS — ABSENT
The selected c |
| desktop | coverage ledger lists absent tokenomics concepts | PASS | all 8 absent concepts listed |
| desktop | counts requested/completed/failed = 100/100/0 | PASS | 100/100/0 |
| desktop | seed + reproducibility metadata visible | PASS | Run id
public-growth-uncertainty-v2-20260816T172044Z-78c1ed33
Scenario
public-growth-uncertainty-v2
Config hash
b1b11ca0dbdb5039030dbe3b3c1c190bb9df263277428c17 |
| desktop | claim eligibility shown | PASS | Claim eligibility: eligible — requested, completed, and failed counts reconcile with zero failures. |
| desktop | workspace isolation: v1 workspace hidden in stochastic mode | PASS | {"v1Display": "none", "wsX": 406, "wsW": 1006, "setupX": 28, "setupW": 360} |
| desktop | layout: stochastic workspace in wide second grid column | PASS | {"v1Display": "none", "wsX": 406, "wsW": 1006, "setupX": 28, "setupW": 360} |
| desktop | setup panel metadata matches selected stochastic demo | PASS | metadata matches |
| desktop | no text labels P10–P90/outcome percentiles as 'confidence interval' | PASS | only estimator/negated CI mentions |
| desktop | artifact download arrives non-empty | PASS | downloaded_convergence.json (1757 bytes) |
| desktop | v1 control labeled 'Deterministic scenario explorer' | PASS | page copy |
| desktop | v1 control does NOT claim Monte Carlo | PASS | only negated/disclaimer mentions |
| desktop | v1 control explicitly disclaims Monte Carlo | PASS | summary/boundary copy |
| desktop | keyboard: Tab reaches Run Monte Carlo button | PASS | prior-average_transaction_final-mode -> prior-average_transaction_final-maximum -> prior-average_transaction_final-approval -> prior-holding_time-minimum -> prior-holding_time-mode -> prior-holding_time-maximum -> prior-holding_time-approval -> mc-run-button |
| desktop | keyboard: focus is visibly indicated | PASS | {"outline": "solid 3px", "boxShadow": "rgba(184, 245, 106, 0.16) 0px 12px 28px 0px"} desktop_06_focus.png |
| desktop | keyboard: Enter activates run to success | PASS | second fast run via keyboard |
| desktop | invalid-spec state via draft approval | PASS | desktop_08_invalid_spec.png; note: Invalid spec — the edited assumptions failed validation and cannot execute. max_users: approval 'draft' is not executabl |
| desktop | cancel: cancelled state with truthful counts | PASS | desktop_09_cancelled.png; note: Cancelled by request after 303 completed and 0 failed of 500 requested paths. No bundle was published; counts above are the exact settled pa |
| desktop | journey: no console errors overall | PASS | console clean |
| desktop | journey: no unexpected failed requests | PASS | only expected invalid-spec 400 |
| narrow | fast run to success at 390px | PASS | narrow_02_success.png |
| narrow | no horizontal overflow of main containers | PASS | {"bad": [], "iw": 390, "dsw": 390} |
| narrow | run control reachable in viewport | PASS | {"x": 29, "y": 0.09375, "width": 332, "height": 50} |
| narrow | no console errors | PASS | console clean |
| narrow | no failed requests | PASS | all responses < 400 |

Totals: 36 pass, 0 fail.
