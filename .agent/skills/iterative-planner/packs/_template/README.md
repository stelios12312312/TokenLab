# Custom Persona Pack Template

Use this template to create a domain-specific persona pack for the iterative planner.

## Quick Start

```bash
# 1. Copy the template
cp -r .agent/skills/iterative-planner/packs/_template .agent/packs/my_domain

# 2. Edit index.mjs:
#    - Change id: "my_domain" to your domain name
#    - Add your DOMAIN_KEYWORDS
#    - Implement applies() auto-detection
#    - Define RULE_DEFS metadata
#    - Fill in getPhaseGuidance() and getPlanConstraints()

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
| `normalizeFinding(raw)` | `(Object) => Finding` | Map raw finding to shared schema via `makeFinding()` |

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
```

Project-local custom packs live at `<project>/.agent/packs/<role>/index.mjs`.

## References

- [audit_types.mjs](../../scripts/lib/audit_types.mjs) — Finding and Constraint schemas
- [role-auditors.md](../../references/role-auditors.md) — Full reference documentation
- [quant pack](../quant/index.mjs) — Example: quantitative domain
- [ux_ui pack](../ux_ui/index.mjs) — Example: UX/UI domain
