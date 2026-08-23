# Universal Patterns
*Proven implementation patterns observed across 8+ projects. Seed file for new project knowledge bases.*

## P-001 | Invariant TDD (Test the Rule, Not the Instance)
**Project origin**: ATP Tennis, Value Investing AI
**Pattern**: Write tests that verify invariants (e.g., "output always ≥0", "no future dates in training data") rather than specific values.
**Why it works**: Invariant tests survive code refactors. Value tests break on every change.
**Recipe**: `assert property_always_holds(output)` not `assert output == 42`.

## P-002 | Adjacency Discovery (Before Every Fix)
**Project origin**: All projects
**Pattern**: Before fixing module A, list all files in the same package, all importers, and all imports. Scan ≥2 siblings for the same bug.
**Why it works**: Bugs cluster in siblings. If `handler_a.py` has a null check bug, `handler_b.py` likely does too.
**Recipe**: `grep_search` for imports from/to the target module. Add discovered files with `[ADJACENCY]` tag.

## P-003 | Diagnostic-First Remediation
**Project origin**: WordPress CQA, IPBS
**Pattern**: For runtime/integration bugs, run a diagnostic capturing actual state BEFORE writing any fix. Compare before/after.
**Why it works**: Prevents "coding blind" — fixing based on source reading without knowing actual runtime behavior.
**Recipe**: `curl`/`print`/`log` the actual value → record as `[RUNTIME_STATE]` → fix → re-run diagnostic.

## P-004 | Column Lineage Trace (Data Pipelines)
**Project origin**: Value Investing AI, IPBS
**Pattern**: For any bug involving missing/wrong data, trace the column/field from source to output. At each step, verify it exists and has expected type.
**Why it works**: Data bugs are often 3+ hops away from where the error manifests.
**Recipe**: Source → transform_1 → transform_2 → output. Check type/shape at each hop.

## P-005 | Machine-Readable Results Store
**Project origin**: ATP Tennis, IPBS
**Pattern**: Store verification results as structured data (JSON), not human-readable logs. Enables automated comparison.
**Recipe**: `{ "test": "calibration", "status": "PASS", "value": 0.023, "threshold": 0.05 }`

## P-006 | Cascading Provider Fallthrough
**Project origin**: WordPress CQA, IPBS
**Pattern**: When a primary integration fails (API auth, SSL, rate limit), fall through to secondary provider automatically.
**Why it works**: External dependencies are unreliable. Silent failure is worse than fallback to a non-optimal alternative.
**Recipe**: try primary → catch → log warning → try secondary → catch → log error with diagnostic.

## P-007 | Revert-First Debugging
**Project origin**: All projects
**Pattern**: When a fix breaks something, revert BEFORE trying another fix. Never stack fix-on-fix.
**Why it works**: Stacked fixes create complexity. Reverting returns to known-good state.
**Recipe**: `git stash` → reproduce → fix cleanly → `git stash drop`.
