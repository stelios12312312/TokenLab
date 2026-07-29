# Custom Persona Pack Template

Use this template to create a domain-specific persona pack for the iterative planner.
The scaffold uses `scripts/lib/auditor_pack_engine.mjs` so new packs do not
copy the shared Prolog load/query/normalize boilerplate.

## Quick Start

```bash
# 1. Copy the template
cp -r .agent/skills/iterative-planner/packs/_template .agent/packs/my_domain

# 2. Edit index.mjs:
#    - Change id: "my_domain" to your domain name
#    - Add your DOMAIN_KEYWORDS
#    - Implement applies() auto-detection
#    - Define RULE_DEFS metadata
#    - Add custom facts inside audit() -> collectFacts
#    - Fill in PHASE_GUIDANCE and getPlanConstraints()

# 3. Edit rules.pl:
#    - Rename my_domain_violation/4 to <your_domain>_violation/4
#    - Write Prolog rules that query story facts

# 4. Register in audit.config.json:
#    { "roles": ["core", "my_domain"] }

# 5. Test:
node .agent/skills/iterative-planner/scripts/audit_runner.mjs --pack my_domain
```

## AuditorPack Contract (v1.1)

### Required Methods

| Method | Signature | Purpose |
|--------|-----------|---------|
| `id` | `string` | Unique pack identifier (must match `/^[a-z][a-z0-9_]*$/`) |
| `applies(ctx)` | `(ProjectContext) => boolean` | Return true when this pack should run |
| `rules()` | `() => RuleDef[]` | Rule metadata (id, name, rationale, false_positive, remediation, engine) |
| `audit(ctx)` | `(ProjectContext) => Promise<RawFinding[]>` | Run rules and return raw findings |
| `normalizeFinding(raw)` | `(Object) => Finding` | Map raw finding to shared schema, usually via `normalizePackFinding()` |

### Optional Methods (v1.1)

| Method | Signature | Purpose |
|--------|-----------|---------|
| `getPhaseGuidance(phase, ctx)` | `(string, ProjectContext) => string\|null` | Phase-specific guidance injected into `persona_guidance.md` |
| `getPlanConstraints(ctx)` | `(ProjectContext) => Constraint[]` | Constraints written to `persona_constraints.md` at explore-to-plan gate |

## ProjectContext

The `context` object passed to your methods contains:

| Field | Type | Description |
|-------|------|-------------|
| `cwd` | `string` | Project working directory |
| `skillPath` | `string` | Skill root directory |
| `storyRegistry` | `Object\|null` | Parsed `story_registry.json` |
| `planFiles` | `Object` | Map of plan file contents (state.md, plan.md, etc.) |
| `auditConfig` | `Object` | Parsed `audit.config.json` |
| `prologSession` | `Object` | Shared Prolog session (story facts pre-loaded) |
| `storyCount` | `number` | Number of stories loaded |

## File Layout

```
packs/<your_domain>/
  index.mjs    — AuditorPack implementation
  rules.pl     — Prolog rules (queried by audit())
  pack_contract.json — E5 reusable/domain shipping contract
```

Project-local custom packs live at `<project>/.agent/packs/<role>/index.mjs`.

## Autocoder Pack Contract (E5-2)

Reusable/domain packs that ship with the planner must include
`pack_contract.json`. The contract is separate from the `AuditorPack` runtime
interface above: it is the autocoder shipping contract used by CI to prove the
pack is reusable, calibrated, and tested against seeded defects.

Required fields:

| Field | Requirement |
|-------|-------------|
| `schema_version` | Must be `1`. |
| `pack_id` | Must match the pack directory name. |
| `rubrics` | Non-empty closed-question rubric array. Every rubric needs `id`, `question`, `closed_question: true`, and at least two `allowed_answers`. |
| `checkers` | Non-empty deterministic checker array. Every checker needs `id`, `deterministic: true`, a `command`, `module`, `script`, or `path`, and `seeded_defect_ids`. |
| `calibration_ref` | Repo-relative calibration artifact. |
| `goldens_ref` | Repo-relative golden fixture registry with at least one fixture for this pack. |
| `seeded_defects_ref` | Repo-relative seeded-defect registry with at least one defect for this pack. |
| `serves_projects` | At least two real projects, not placeholders or one-off examples. |

Process personas are kernel behavior, not reusable autocoder packs. The
validator reports `assumptions_challenger`, `traceability`, `config_integrity`,
and `wiring_auditor` as `kernel_process_persona` exemptions instead of requiring
rubrics, checkers, calibration, goldens, or seeded defects.

CI uses the existing IVE conformance runner:

```bash
node .agent/skills/iterative-planner/scripts/pack_contract_validate.mjs --json
node .agent/skills/iterative-planner/tests/ive/run.mjs --only pack-contract --json
```

## References

- [auditor_pack_engine.mjs](../../scripts/lib/auditor_pack_engine.mjs) — Shared Prolog pack runner, story fact assertion, phase guidance formatter, and finding normalizer
- [audit_types.mjs](../../scripts/lib/audit_types.mjs) — Finding and Constraint schemas
- [role-auditors.md](../../references/role-auditors.md) — Full reference documentation
- [quant pack](../quant/index.mjs) — Example: quantitative domain
- [ux_ui pack](../ux_ui/index.mjs) — Example: UX/UI domain
