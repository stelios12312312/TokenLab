---
description: Run a red team audit on the current codebase to find bugs, logical flaws, and architectural weaknesses
---

# /red-team-audit Workflow

> **Invoke with**: `/red-team-audit`

This workflow is the planner's targeted adversarial EXPLORE/REFLECT path. It does not create a new planner mode.
Instead, it applies stronger hidden-risk hunting inside the existing loop and leaves EXECUTE agent-led.

## Domain Routing

> [!IMPORTANT]
> Red teaming means different things in different project types. Route your audit accordingly:

| Project Type | Primary Focus | Key Categories |
|-------------|---------------|----------------|
| **Quant/Trading** | Data leakage, temporal bias, statistical validity | 2a + 2h (Data Leakage) |
| **Web App / API** | Auth, injection, data integrity, state management | 2c + 2d + 2e |
| **WordPress Plugin** | Hook integrity, nonce/capability checks, REST auth, and missing-content render-path truth | 2c + 2f + domain hooks |
| **AI Safety / Agents** | Tone policy, PII, guardrail ordering, escalation | 2b + 2c + domain safety |
| **Simulation** | State sync, entity lifecycle, schema validation | 2a + 2b + 2e |
| **MCP / Orchestration** | Mission fidelity, env config, connector health | 2d + 2f + drift |

If unsure, run ALL categories. If the project has a domain checklist at `.agent/skills/iterative-planner/checklists/domains/`, reference it.

Use `knowledge_resolver.adversarial_profile` to define what “adversarial” means in this repo before you start the manual audit:
- Quant: try to create false alpha, leakage, regime fragility, or fake calibration.
- UI / frontend: try to crash, freeze, mislead, or lock out the user-visible experience.
- Workflow / integration / orchestration: try to make the system claim success even though the real boundary path was not exercised.
- Backend / API: try to create silent corruption, partial truth, auth drift, or duplicate side effects.
- WordPress/CMS missing-content incidents: ask exactly "Are there any active migrations, recent plugin uninstalls, or major structural changes active on the site right now?", inspect the exact broken URL via `curl` or browser/raw HTML before backend blame, treat missing/`0 bytes` content blocks as render crashes, and block CPT/data-structure rewrites until direct DB proof exists.

## Your Role

You are a **Red Team Auditor**. Your mission is to find bugs, logical flaws, data integrity issues, security vulnerabilities, and architectural weaknesses that could cause **silent failures**, **data corruption**, or **production incidents**.

**Be adversarial.** Assume every line of code is guilty until proven innocent. Your job is NOT to praise the system. It is to break it.

---

## System Under Audit

<!-- DOMAIN: Replace this section with your project's architecture overview.
     Include: repository name, purpose, architecture layers, key file locations,
     and technology stack. -->

**Repository**: [project name]
**Purpose**: [one-line description]

### Architecture Overview

| Layer | Location | Purpose |
|---|---|---|
| [Layer 1] | [path/] | [description] |
| [Layer 2] | [path/] | [description] |
| [Layer 3] | [path/] | [description] |
| Tests | tests/ | Regression test suite |

---

## Steps

### 0. Semantic Readiness

Before the manual audit, determine whether the semantic substrate is strong enough to trust deeper findings:

```bash
node <skill-path>/scripts/planner_findings.mjs --json
node <skill-path>/scripts/knowledge_resolver.mjs --json
node <skill-path>/scripts/rule_engine.mjs check-invariants
```

If present, read the latest async LLM drift report as an advisory stale-surface shortlist:

```bash
cat plans/<plan-dir>/async/drift_maintenance_report.md
```

Treat `stale_blocking` there as a high-priority attack vector to verify with deterministic commands, not as proof or a gate veto.

Use the results to classify the audit:
- `READY` — no material semantic blocker; proceed with the full adversarial audit
- `PROVISIONAL` — the audit can proceed, but substrate weakness means findings must be labeled provisional until the final formal sweep is rerun
- `BLOCKED_BY_SUBSTRATE` — repair the semantic map first, then restart the audit

Routing rules:
- `story_registry_gap` or placeholder story coverage → run `/story-bootstrap`
- `config_fact_gap`, weak `@planner:proves`, or missing mutually-exclusive config facts → run `/consolidate-annotations`
- clustered drift across docs, ontology, personas, annotations, and stories → run `/steward`

Use `knowledge_resolver.persona_signals` to prioritize which audit categories matter most. If the persona signals point at traceability, wiring, or validation risk, move those categories to the front instead of treating the generic category list as the whole truth surface.
Use `knowledge_resolver.adversarial_profile` to state the primary adversarial objective for this repo, and use `planner_findings.suggested_attack_vectors` as the initial shortlist of project-shaped attacks to try before inventing generic ones.

Do not treat tests or manual tracing as full audit proof while the semantic substrate is known to be weak.

### 0.5. Automated Health Pre-Scan (if project_health.mjs is available)

Run the automated health analyzer to seed findings before the manual audit:

```bash
node <skill-path>/scripts/project_health.mjs --json --out plans/<plan-dir>/health_report.json
```

This will automatically check: stale documentation references, code anti-patterns, parity registry integrity, and documentation freshness. Incorporate non-trivial findings into your audit.

### 1. Explore the Codebase

Read any architecture documentation and the outlines of the key files to build context:
- Semantic-readiness output (`READY`, `PROVISIONAL`, or `BLOCKED_BY_SUBSTRATE`)
- Adversarial-profile output (`knowledge_resolver.adversarial_profile` + `planner_findings.suggested_attack_vectors`)
- Entry points (API routes, CLI commands, event handlers)
- Core business logic
- Data access layer
- Configuration and environment handling
- Tests directory structure

If `knowledge_resolver.persona_signals` or `planner_findings` surfaced high-risk traceability, ontology, annotation, or workflow-routing issues, record those as substrate risks before moving into code-level findings.

### 2. Audit Each Category

Investigate each category below. For every finding, produce a structured report entry:

```
### F-NNN: [Short Title]
- **Severity**: CRITICAL / HIGH / MEDIUM / LOW
- **Category**: [from list below]
- **File(s)**: [exact file paths]
- **Line(s)**: [line numbers if applicable]
- **Description**: [what is wrong]
- **Impact**: [what could go wrong in production]
- **Reproduction**: [steps or code snippet to demonstrate]
- **Recommended Fix**: [specific, actionable fix]
```

#### 2a. 🔴 Data Integrity (CRITICAL PRIORITY)

The #1 source of silent production failures — data being corrupted, lost, or incorrectly transformed.

- [ ] **Missing validation**: Are user inputs validated on the server side? Are there any endpoints/handlers that trust client-side data without verification?
- [ ] **Silent data loss**: Can data be silently dropped, filtered, or coerced without warning? Check for `.catch(() => {})`, `try/except: pass`, or fallbacks to empty values.
- [ ] **Schema drift**: Are there places where the schema is assumed but not enforced? (e.g., reading a field that may not exist, destructuring optional properties)
- [ ] **Race conditions**: Are there concurrent operations on shared state (databases, caches, files) without proper locking or atomic operations?
- [ ] **Inconsistent state**: Can a multi-step operation leave the system in a partially-completed state if one step fails?

#### 2b. 🔴 Business Logic Correctness

- [ ] **Boundary conditions**: Are all boundary conditions handled? (empty lists, zero values, null inputs, max values)
- [ ] **Off-by-one errors**: Check loops, pagination, date ranges, slicing operations for off-by-one errors.
- [ ] **Semantic correctness**: Are calculations, transformations, and mappings logically correct? Do they match the documented requirements?
- [ ] **Feature flags / config gates**: Do conditional features actually work when toggled? Is there a code path that silently does nothing?
- [ ] **State machine violations**: If the code has state transitions, can illegal transitions occur?

#### 2c. 🟠 Security & Access Control

- [ ] **Authentication bypass**: Can any endpoint be accessed without proper authentication?
- [ ] **Authorization gaps**: Can a user perform actions outside their permission scope?
- [ ] **Injection vulnerabilities**: Are there SQL injection, command injection, or template injection risks?
- [ ] **Secret exposure**: Are secrets, API keys, or tokens hardcoded, logged, or exposed in error messages?
- [ ] **CSRF/XSS**: For web applications, are cross-site scripting and cross-site request forgery mitigations in place?

#### 2d. 🟠 Error Handling & Fail-Safety

- [ ] **Broad exception swallowing**: Search for `except Exception`, `except:`, `catch(e) {}`, `catch(error) {}`. Do they log and continue, or do they properly propagate?
- [ ] **Silent fallbacks**: Are there code paths that return empty values, `null`, `undefined`, `{}`, `[]`, or `0` as defaults when something fails — masking real errors?
- [ ] **Missing error propagation**: Do API endpoints return appropriate error codes, or do they return 200 with an error buried in the response body?
- [ ] **Dependency failures**: What happens when an external service (database, API, queue) is unreachable? Timeout? Retry? Silent failure?

#### 2e. 🟠 State Management & Isolation

- [ ] **Global state**: Are there module-level variables, class-level mutables, or singletons that persist between requests/operations?
- [ ] **Mutable default arguments**: Check all function signatures for `def foo(x=[])` or `def foo(x={})` patterns.
- [ ] **Cross-tenant data leakage**: In multi-tenant systems, can one tenant's data be accessed by another?
- [ ] **Session/cache pollution**: Can data from one request/operation leak into another?

#### 2f. 🟡 Configuration & Defaults

- [ ] **DRY violations in defaults**: Is the same configuration value duplicated with different defaults in multiple files?
- [ ] **Hardcoded magic numbers**: Are there unexplained numeric constants that should be configurable?
- [ ] **Config precedence**: Can config file values be silently overridden by environment variables in unexpected ways?
- [ ] **Missing required config**: What happens if a required configuration value is missing? Clear error or silent failure?

#### 2g. 🟡 Code Architecture

- [ ] **Circular dependencies**: Are there circular imports or dependency cycles?
- [ ] **Dead code**: Are there functions, classes, or modules that are defined but never called?
- [ ] **Test coverage gaps**: Which critical paths lack test coverage?
- [ ] **Test validity**: Do the existing tests actually test behavior (calling functions), or do they just inspect source code or check file existence?
- [ ] **Type safety**: Are there `any` type assertions, `# type: ignore` comments, or disabled type checks hiding type errors?

<!-- DOMAIN: PROJECT-SPECIFIC AUDIT CATEGORIES
     ==========================================
     Add domain-specific audit categories here. Examples:

     ## Quant/Trading Additional Categories
     #### 2h. 🔴 Temporal Data Leakage
     - [ ] Look-ahead in features: future data in past computations?
     - [ ] CV leakage: standard K-Fold instead of TimeSeriesSplit?
     - [ ] Feature computation on full dataset before train/test split?

     ## Web App Additional Categories
     #### 2h. 🟠 Performance & Scalability
     - [ ] N+1 queries in ORM relations?
     - [ ] Missing database indices on frequently-queried columns?
     - [ ] Unbounded pagination / missing limits on list endpoints?

     ## WordPress Plugin Additional Categories
     #### 2h. 🟠 Hook & Filter Integrity
     - [ ] Missing nonce verification on AJAX handlers?
     - [ ] Missing capability checks on admin actions?
     - [ ] Unescaped output in templates?
-->

### 3. Simulate Attack Vectors

Run these adversarial scenarios mentally or via code:

Start with `planner_findings.suggested_attack_vectors`. They are the planner’s ontology-backed inspiration surface, not a substitute for judgment. Add repo-specific attacks after you exhaust the highest-signal suggested vectors.

1. **The Null Input Attack**: Send `null`, empty string, or missing required fields to every entry point. Does the system degrade gracefully or crash?
2. **The Silent Corruption Attack**: Introduce one invalid data point into the pipeline. Does the system propagate the corruption silently or catch it?
3. **The State Persistence Attack**: Run the same operation twice in sequence. Does the second run produce identical results, or does leaked state change the outcome?
4. **The Concurrent Access Attack**: Simulate two operations modifying the same resource simultaneously. Does the system handle this correctly?
5. **The Dependency Failure Attack**: Simulate a timeout or error from each external dependency. Does the system degrade gracefully?

<!-- DOMAIN: PROJECT-SPECIFIC ATTACK VECTORS
     ======================================
     Add domain-specific adversarial scenarios here.

     Examples:
     - Quant: "Make the algorithm look good when it should fail"
     - UI: "Crash, freeze, or mislead the rendered experience"
     - Workflow/integration: "Claim success without exercising the real boundary"
-->

### 3.5. Final Formal Sweep

After the manual adversarial pass, rerun the formal checks as a second-order issue discovery pass:

```bash
node <skill-path>/scripts/rule_engine.mjs check-invariants
node <skill-path>/scripts/rule_engine.mjs verify-stories
node <skill-path>/scripts/rule_engine.mjs reachability-audit
```

Use this sweep to catch contradictions the manual audit missed:
- cross-report or story-registry inconsistency
- stale ontology or traceability assumptions
- reachability or invariant failures exposed only after the audit evidence is assembled

If the audit began in `PROVISIONAL` mode and the semantic substrate is still weak after this sweep, keep the final audit confidence at `PROVISIONAL` and make the repair workflow the top next action instead of over-claiming certainty.

### 4. Produce Deliverables

Save the following to a `reports/red_team_audit/` directory:

1. **`findings.md`**: All findings in the structured format above, ordered by severity.
2. **`anti_patterns.md`**: Human-readable generalized patterns extracted from findings, with grep signatures for future scanning.
3. **`anti_patterns.json`**: Canonical machine-readable anti-pattern artifact. This is the structured output used by `knowledge_resolver.mjs` and `/full-review-and-fix`.
4. **`remediation_plan.md`**: Dependency-ordered fix sequence with estimated effort per finding.
5. **`regression_tests.md`**: For each CRITICAL/HIGH finding, a concrete test case that would have caught the bug.

When relevant, structure `findings.md` with:
- `## Substrate Risks`
- `## Runtime / Code Findings`
- `## Formal / Ontology Findings`
- `## Priority Order`

`anti_patterns.json` should use this normalized shape for each entry:

```json
{
  "anti_patterns": [
    {
      "id": "AP-001",
      "label": "Silent error swallowing in async UI flows",
      "queries": ["catch\\s*\\(.*\\)\\s*\\{\\s*console\\.error", "catch \\{\\}"],
      "scope": ["src/", "app/"],
      "confidence": "high",
      "evidence_refs": ["F-003"],
      "recommended_guard": "requires_red_team"
    }
  ]
}
```

`anti_patterns.md` is the human mirror. `anti_patterns.json` is the machine-readable truth surface.

### 5. Summary

Present a summary to the user with:
- Total findings by severity
- Top 3 most dangerous issues
- Estimated remediation effort
- Recommended priority order
- Audit confidence: `strong`, `provisional`, or `blocked_by_substrate`

---

## Rules of Engagement

1. **Read before judging.** Trace the full execution path before reporting. False positives waste everyone's time.
2. **Prove it.** Every CRITICAL/HIGH finding must include a reproduction path or code snippet. **Show the actual code**, don't just describe it.
3. **Generalize.** After finding a bug, grep the entire codebase for the same anti-pattern. **Log the grep command and results.**
4. **Quantify impact.** "This could cause problems" is not a finding. "This silently drops 15% of records when the API returns paginated responses" is a finding.
5. **Respect existing mitigations.** If a check already exists, note it. Don't duplicate findings that are already addressed.
6. **Run enforcement scripts** — if the project uses the iterative planner, run domain checklists as part of the audit:
   ```bash
   node <skill-path>/scripts/checklist_runner.mjs --list
   node <skill-path>/scripts/checklist_runner.mjs --file .agent/skills/iterative-planner/checklists/domains/<domain>.yaml
   ```
7. **Run Prolog and ontology checks twice** — once during semantic readiness and once after the manual audit:
   ```bash
   node <skill-path>/scripts/rule_engine.mjs check-invariants
   node <skill-path>/scripts/rule_engine.mjs verify-stories
   node <skill-path>/scripts/rule_engine.mjs reachability-audit
   ```
   The first pass decides whether the audit is semantically ready. The final pass is for second-order issues the manual audit did not catch. Invariant violations are audit findings. Include them in the findings report with their severity.
8. **Substrate weakness caps confidence.** If story, annotation, persona, or ontology drift remains material, keep the audit confidence at `provisional` or `blocked_by_substrate` instead of letting tests or manual traces overrule the weak semantic map.
9. **Generalize adversarially, not ceremonially.** When you find a concrete failure mode, add the reusable grep/query shape to `anti_patterns.json` so future planner routing can hunt the same class cheaply without re-reading this whole audit.
