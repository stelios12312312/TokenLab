# Role-Specific Auditors

> Extracted from SKILL.md. Full reference for persona audit packs.

The iterative planner **requires at least one domain persona pack** active per project. Role packs extend the core audit with domain-specific checks powered by Prolog or JS rules. If no pack is explicitly configured in `audit.config.json`, the system auto-detects applicable packs from project signals (story registry keywords, plan files, dependency files like `package.json`/`requirements.txt`, metadata files, and code patterns). If auto-detection finds no match, the agent **must** configure `audit.config.json` with the most relevant persona before proceeding.

## Enabling role packs

Create `audit.config.json` at your project root (see `audit.config.example.json` for a template):

```json
{
  "roles": ["core", "assumptions_challenger"],
  "auto_committee": true,
  "fail_on": ["HIGH", "CRITICAL"],
  "role_options": {}
}
```

Once present, `project_health.mjs` automatically runs the configured packs. You can also run packs standalone:

```bash
node <skill-path>/scripts/audit_runner.mjs               # all configured packs
node <skill-path>/scripts/audit_runner.mjs --pack quant  # single pack
node <skill-path>/scripts/audit_runner.mjs --list-packs  # show available packs
node <skill-path>/scripts/audit_runner.mjs --report-only # never fail CI (dry run)
node <skill-path>/scripts/persona_execute.mjs --json     # execution-ready persona guidance
```

`roles` is a seed, not a hard ceiling. By default `auto_committee: true` lets the runner add evidence-critical companion packs when a configured pack reveals a higher-risk task. For example, a quant plan can add applicable `quant_target`, `assumptions_challenger`, `wiring_auditor`, and `traceability` packs so model targets, betting odds snapshots, data claims, optimizer output, wiring, and evidence chains are reviewed together. A tokenomics plan can add assumptions, wiring, and traceability companions so token supply, vesting, liquidity, treasury, governance, and claim-boundary assumptions stay linked to proof. Set `"auto_committee": false` only when the extra packs are intentionally out of scope.

## Persona activation authority

`audit.config.json.roles` records persona seed inventory; the active plan shape and planned files decide which packs are authoritative for a specific run. The shared authority contract is used by `persona_adapt.mjs`, `audit_runner.mjs`, `project_health.mjs`, and verification-obligation synthesis.

Planner-core, integration, migration, docs, chore, and analysis shapes suppress non-authoritative packs such as `quant`, `quant_target`, and `ux_ui` unless `audit.config.json.force_packs` explicitly restores them. Suppressed profiles stay visible in `suppressed_domain_profiles` and `persona_activation_authority` so operators can audit why a pack was quiet, but suppressed packs must not emit warnings, block gates, or synthesize proof obligations.

`ux_ui` is authoritative for real product/browser work, Visualizer surfaces, and Phase 5 product UI proof. It should stay suppressed for planner-core implementation unless the active plan actually touches UI/browser files or `force_packs` names it. Quant packs remain authoritative for scientific/IPBS-style work and quiet for planner-core work even if quant roles remain configured as historical seed inventory. When explicitly forced for planner-core reviewer maintenance, `quant` and `quant_target` audit the reviewer contract itself: semantic-role time independence, actual evidence recomputation, target/hypothesis identity, parameter-choice rationale, provenance, and five-axis verdict consistency.

## Adaptation scanner

Use the adaptation scanner when a project may have the wrong seed roles or when personas appear absent from serious plans:

```bash
node <skill-path>/scripts/persona_adapt.mjs scan . --json
node <skill-path>/scripts/persona_adapt.mjs scan --all --json
node <skill-path>/scripts/persona_adapt.mjs apply . --safe
```

The scanner evaluates four layers: available packs, configured seed roles, recent serious-plan usage, and whether trivial work is staying quiet. It recognizes quant/model/finance, betting/odds/CLV/MIM, tokenomics/token-economics, automation/orchestration, frontend/user-facing, and planner/config/infrastructure evidence. `bootstrap status`, serious `bootstrap new`/`triage`, and `migrate.mjs verify-fleet --json` surface the same status so this check is part of ordinary planner operation.

`apply --safe` is deliberately narrow: it only adds high-confidence missing seed roles, never removes roles, preserves `fail_on`, `ignore`, and all project-owned options, adds `"auto_committee": true` only when missing, and reports but does not override an explicit `"auto_committee": false`. Invalid config or medium/low confidence means no write.

## Execution guidance script

`persona_execute.mjs` is the deterministic execution surface for persona obligations:

```bash
node <skill-path>/scripts/persona_execute.mjs --json
node <skill-path>/scripts/persona_execute.mjs --plan plan_YYYY... --phase execute --write --json
```

The JSON report includes the selected plan, persona config/adaptation status, authority decisions, configured/loaded/suppressed packs, phase guidance, plan constraints, role findings, and normalized obligations. It is read-only unless `--write` is supplied; write mode stores `persona_execution.json` and `persona_execution.md` in the target plan directory.

Missing or invalid persona config and high-confidence underfit emit blocking obligations with repair commands. Advisory underfit is reported but does not fail by default; use `--strict-underfit` when a CI or conformance runner needs advisory underfit to fail.

## Built-in packs

| Pack id | Domain | Rules |
|---------|--------|-------|
| `quant` | Quantitative / trading | QU-001 data leakage, QU-002 backtest horizon, QU-003 risk metrics, QU-004 train/test split, QU-005 calibration, QU-006 source-level leakage smells, plus semantic scientific review of referenced dates, counts, hashes, universe, folds, trials, observations, provenance, identities, and counterarguments; PLAN constraints require data-source/lineage, optimizer-scale disclosure, model-family search coverage, statistical rigor, degenerate-output routing, metric lineage, alpha discovery, and result validation |
| `quant_target` | Quant target semantics / betting market microstructure | QT-001 model target contract, QT-002 target-to-claim justification, QT-003 odds snapshot matrix, QT-004 CLV provenance repair route, plus preregistered mechanism/prior/alternatives/basis/rationale/sensitivity for windows, frequency, universe, families, ranges, weights, thresholds, trials, and folds; PLAN constraints require label formula, prediction time, known-at-time data, forbidden future fields, proof metric, label type, price matrix where applicable, and exact target/hypothesis identity |
| `ux_ui` | UX / UI / frontend | UX-001 a11y baseline, UX-002 critical flow coverage, UX-003 error state coverage, UX-004 interaction consistency; PLAN constraints require browser journey proof plus screenshot/captured-viewport artifacts for changed user-visible states |
| `assumptions_challenger` | Planner / infra / output-critical systems | AC-001 calibration proof, AC-002 edge proof, AC-003 evidence chains, AC-004 validation artifacts, AC-005 degenerate outputs |
| `wiring_auditor` | Validation / guard / pipeline wiring | WR-001 unwired validation, WR-002 disabled validation, WR-003 disabled check expiry, WR-004 output-critical validation refs |
| `traceability` | Goal → criterion → story → code → validation graph | TR-001 ungrounded criterion, TR-002 partial criterion, TR-003 goal at risk, TR-004 orphan story, TR-005 audit blind spot, TR-006 claimed-without-evidence |

## Severity policy

| Severity | Default CI behavior |
|----------|---------------------|
| `CRITICAL` | Always fail CI |
| `HIGH` | Fail CI (configurable via `fail_on`) |
| `MEDIUM` | Report only |
| `LOW` / `INFO` | Report only |

## Optional metadata files

Packs auto-detect project context but produce richer findings when you supply metadata:

- **`quant_metadata.json`** — `backtest_days`, `split_method`, `data_type`, `metrics`, `feature_source`
- **`ux_metadata.json`** — `critical_flows`, `a11y_standard`, `has_a11y_audit`, `excluded_flows`

Both files can live at `<cwd>/`, `<cwd>/.agent/`, or `<cwd>/plans/knowledge/`.

## IVE fact-route metadata

Quant-oriented PLAN constraints may include additive `meta.ive` metadata. This does not change gate behavior by itself; it preserves the IVE bridge for future agents and JSON consumers:

- `knowledge_pack`: source family such as `statistical_rigor`, `degenerate_output`, `metric_lineage`, or `market_odds_provenance`.
- `fact_templates`: ontology-like facts such as `policy_selected_zero_bets`, `clv_provenance_unrepaired`, `bootstrap_ci_missing`, or `transformed_metric_reported_as_raw`.
- `concept_guards`: definitions or claim boundaries protected by the constraint.
- `valid_next_actions`: next actions such as `fix_now`, `ticket_now`, `run_experiment`, or `accept_limitation`.
- `verification_required`: proof needed to clear, route, or accept the fact.
- `memory_guard`: durable guard that prevents the same report-churn failure from recurring.

Markdown reports remain presentation surfaces. When `meta.ive.fact_templates` imply a repair, ticket, experiment, user decision, or accepted limitation, report existence alone is not closure.

## Adding a custom pack

Start from the template scaffold — it includes all required and optional methods with documentation:

```bash
cp -r packs/_template .agent/packs/<your_domain>
```

See `packs/_template/README.md` for step-by-step instructions.

The `AuditorPack` contract (v1.1) requires:
   - `id` — unique string (must match `/^[a-z][a-z0-9_]*$/`)
   - `applies(context)` — return `true` when the pack should run
   - `rules()` — return array of `RuleDef` objects (metadata only)
   - `audit(context)` — async; return array of raw findings
   - `normalizeFinding(raw)` — map raw finding to shared schema (use `makeFinding` from `scripts/lib/audit_types.mjs`)

Optional (v1.1):
   - `getPhaseGuidance(phase, context)` — return domain-specific guidance string for a phase (written to `persona_guidance.md`)
   - `getPlanConstraints(context)` — return array of `Constraint` objects (written to `persona_constraints.md` at explore-to-plan)

Steps:
1. Copy template and customize `index.mjs` and `rules.pl`.
2. Add `.agent/packs/<role>/rules.pl` for Prolog-backed rules (recommended — packs can work without, but Prolog enables formal verification).
3. Add `"<role>"` to `roles` in `audit.config.json`.
4. Test: `node scripts/audit_runner.mjs --pack <role>`

## Workflow profiles (recommended)

| Profile | `roles` value | Use case |
|---------|---------------|----------|
| quant | `["core", "quant"]` | Trading / ML-finance / data science. Auto-committee may add target-semantics, assumptions, wiring, and traceability when applicable. |
| ux-ui | `["core", "ux_ui"]` | Frontend / product / UI |
| planner-infra | `["core", "assumptions_challenger"]` | Planner, workflow, infrastructure, proof-heavy repos |
| full | `["core", "quant", "ux_ui"]` | Red-team / thorough audit / mixed projects |

> **Note**: `["core"]` alone is no longer a valid configuration. Every project must have at least one domain persona active. If `audit.config.json` only lists `"core"`, the system will auto-detect applicable packs. If none are detected, the agent must add the most relevant pack before proceeding.

## Script inventory

| Script | Purpose |
|--------|---------|
| `scripts/audit_runner.mjs` | Role-pack loader, runner, and CLI |
| `scripts/persona_adapt.mjs` | Persona fit/usage scanner and explicit high-confidence safe apply |
| `scripts/persona_execute.mjs` | Deterministic execution guidance from persona authority, adaptation, guidance, constraints, and findings |
| `scripts/lib/persona_adaptation.mjs` | Shared persona profile engine used by bootstrap, fleet verification, and the CLI |
| `scripts/lib/audit_types.mjs` | Shared finding schema and pack contract |
| `packs/quant/index.mjs` | Quant auditor pack |
| `packs/quant/rules.pl` | Quant Prolog rules |
| `packs/quant_target/index.mjs` | Quant target / market microstructure auditor pack |
| `packs/quant_target/rules.pl` | Quant target migration placeholder for future Prolog rules |
| `packs/ux_ui/index.mjs` | UX/UI auditor pack |
| `packs/ux_ui/rules.pl` | UX/UI Prolog rules |
| `packs/_template/` | Custom pack scaffold (copy to create new packs) |
| `audit.config.example.json` | Project config template |
