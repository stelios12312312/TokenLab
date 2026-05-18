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
```

`roles` is a seed, not a hard ceiling. By default `auto_committee: true` lets the runner add evidence-critical companion packs when a configured pack reveals a higher-risk task. For example, a quant plan can add applicable `quant_target`, `assumptions_challenger`, `wiring_auditor`, and `traceability` packs so model targets, betting odds snapshots, data claims, optimizer output, wiring, and evidence chains are reviewed together. A tokenomics plan can add assumptions, wiring, and traceability companions so token supply, vesting, liquidity, treasury, governance, and claim-boundary assumptions stay linked to proof. Set `"auto_committee": false` only when the extra packs are intentionally out of scope.

## Adaptation scanner

Use the adaptation scanner when a project may have the wrong seed roles or when personas appear absent from serious plans:

```bash
node <skill-path>/scripts/persona_adapt.mjs scan . --json
node <skill-path>/scripts/persona_adapt.mjs scan --all --json
node <skill-path>/scripts/persona_adapt.mjs apply . --safe
```

The scanner evaluates four layers: available packs, configured seed roles, recent serious-plan usage, and whether trivial work is staying quiet. It recognizes quant/model/finance, betting/odds/CLV/MIM, tokenomics/token-economics, automation/orchestration, frontend/user-facing, and planner/config/infrastructure evidence. `bootstrap status`, serious `bootstrap new`/`triage`, and `migrate.mjs verify-fleet --json` surface the same status so this check is part of ordinary planner operation.

`apply --safe` is deliberately narrow: it only adds high-confidence missing seed roles, never removes roles, preserves `fail_on`, `ignore`, and all project-owned options, adds `"auto_committee": true` only when missing, and reports but does not override an explicit `"auto_committee": false`. Invalid config or medium/low confidence means no write.

## Built-in packs

| Pack id | Domain | Rules |
|---------|--------|-------|
| `quant` | Quantitative / trading | QU-001 data leakage, QU-002 backtest horizon, QU-003 risk metrics, QU-004 train/test split, QU-005 calibration, QU-006 source-level leakage smells in plan/story-referenced model files; PLAN constraints require data-source/lineage and optimizer-scale disclosure |
| `quant_target` | Quant target semantics / betting market microstructure | QT-001 model target contract, QT-002 target-to-claim justification, QT-003 odds snapshot matrix; PLAN constraints require label formula, prediction time, known-at-time data, forbidden future fields, proof metric, CLV/excess-return/realized-return label type, and entry/reference price matrix |
| `tokenomics` | Token economics / token launch review | TK-001 supply/emissions contract, TK-002 vesting/unlock pressure, TK-003 incentive sustainability, TK-004 liquidity/treasury/governance authority, TK-005 financial claim boundary, TK-006 legal/regulatory review boundary; PLAN constraints require advisory tokenomics assumptions without giving financial or legal advice |
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
