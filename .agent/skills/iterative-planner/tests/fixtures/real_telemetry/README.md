# Real-Telemetry Fixtures

This directory holds committed gate-transition telemetry from real planner plans.
`ritual_replay.mjs` and `behavior_report.mjs` auto-discover every `*.jsonl` file here.

## Fixture Categories

| Fixture | Project | Domain | Purpose |
|---------|---------|--------|---------|
| `crawler_extractor_GATE-TMP-002.jsonl` | crawler-extractor-agent | integration/backend | Canonical GATE-TMP-002 tamper false-green |
| `crawler_extractor_GATE-VAL-015.jsonl` | crawler-extractor-agent | integration/backend | validate-to-close delayed unblock / streak attribution |
| `evolution_trading_GATE-ETR-008.jsonl` | evolution-trading-scientist | quant/scientific | GATE-ETR-008 self-clear with streak-union attribution |
| `evolution_trading_scientist_GATE-EXP-001.jsonl` | evolution-trading-scientist | quant/scientific | explore-to-plan coverage |
| `financial_risk_GATE-EXP-009.jsonl` | financial-risk | quant/scientific | findings-depth coverage |
| `ipbs_datapack_starter_GATE-EXP-001.jsonl` | ipbs_datapack_starter | data/scientific | explore-to-plan coverage |
| `ipbs_GATE-REF-003.jsonl` | ipbs_datapack_starter | data/scientific | reflect-to-validate self-clear |
| `portable_agent_kit_GATE-*.jsonl` | portable-agent-kit | planner itself | Self-hosting planner telemetry across many gates |
| `tesseract_GATE-ETR-008.jsonl` | tesseract-automation-engine | integration/backend | Repeated-block stuck case (NOT self-clearing) |
| `tokenlab_GATE-EXP-001.jsonl` | tokenlab | tokenomics | explore-to-plan self-clear |
| `tokenlab_GATE-TMP-002.jsonl` | tokenlab | tokenomics | GATE-TMP-002 coverage |
| `trueskill_atp_tennis_GATE-EXP-009.jsonl` | trueskill-atp-tennis | quant/scientific | explore-to-plan coverage |
| `trueskill_tennis_GATE-REF-003.jsonl` | trueskill-atp-tennis | quant/scientific | reflect-to-validate self-clear |
| `valueinvesting_reflect_to_close_stuck.jsonl` | valueinvestingai | value investing | Stuck reflect-to-close vs. self-clearing gates |
| `valueinvestingai_GATE-PLN-017.jsonl` | valueinvestingai | value investing | plan-to-execute verification matrix |
| `content_marketing_site.jsonl` | content-marketing-site | docs/content/marketing | **Lightweight content-only fixture** |

## `content_marketing_site.jsonl`

Added under ticket **T-INTAKE-D20EF603**.

- Represents a simple documentation / content / marketing-site project.
- Touched files are markdown/content files and minimal config (`README.md`, `docs/about.md`, `blog/welcome.md`, `config/site.json`).
- Contains **no** backend, orchestration, recipe, or integration surfaces.
- All six gate transitions (`explore-to-plan` → `plan-to-execute` → `execute-to-reflect` → `reflect-to-validate` → `validate-to-close` → `notify-user`) are `ALLOWED`.
- Contributes **zero** current ritual transitions and **zero** active blocked transitions, ensuring plan-to-execute strictness does not over-fire on trivial content changes.
