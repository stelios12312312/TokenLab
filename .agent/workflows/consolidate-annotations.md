---
description: Review auto-generated annotations, add domain-specific @planner enrichment (proves, mutually_exclusive), and validate full traceability coverage for a single project
---

# /consolidate-annotations Workflow

Completes the annotation bootstrapping for a single project. Run this **inside the target project's own session** after `/migrate-all` has applied the high-confidence annotations.

This workflow bridges the gap between automated structural annotations (consumer wiring, validation modules) and domain-specific semantic annotations (criterion proofs, config conflicts) that only a human + AI with project context can determine.

## Prerequisites

- Project already upgraded to v3.5.1+ (planner files present)
- `annotation_assist.mjs --apply` already ran (high-confidence annotations present)
- `plans/annotation_review.md` exists with medium/low confidence suggestions

## Phase 1: Assess Current State

1. **Check traceability coverage**:
   ```bash
   node .agent/skills/iterative-planner/scripts/ontology_serializer.mjs --json
   ```
   Note the meta counts. Key gaps to address:
   - `criteria: 0` → plan.md needs `## Success Criteria`
   - `criterion_story_links: 0` → needs story-to-criterion mapping
   - `annotation_proves: 0` → needs `@planner:proves` annotations
   - `validation_artifacts: 0` → validation files not detected

2. **Check annotation validation**:
   ```bash
   node .agent/skills/iterative-planner/scripts/annotation_parser.mjs --validate
   ```
   Fix any errors before proceeding.

3. **Read async drift maintenance if present**:
   ```bash
   cat plans/<plan-dir>/async/drift_maintenance_report.md
   ```
   Use it only as an advisory shortlist. LLM-suggested `@planner:proves`, `@planner:story`, story registry, or ontology claim edits require deterministic proof from the validation steps in this workflow before applying.

4. **Read the review checklist**:
   ```bash
   cat plans/annotation_review.md
   ```
   This contains medium/low confidence suggestions from the auto-scan.

## Phase 2: Fix Plan Gaps

5. **Ensure plan.md has `## Success Criteria`**. If missing, read the plan and add numbered criteria:
   ```markdown
   ## Success Criteria
   1. Model predictions have calibration error < 5% on holdout set
   2. All validation modules are wired and producing outputs
   3. No mutually exclusive config flags enabled simultaneously
   ...
   ```
   These criteria become the traceability anchors — every criterion should eventually have an evidence chain.

6. **Ensure plan.md has `## Goal`**. If missing, add a single-sentence goal:
   ```markdown
   ## Goal
   Build a profitable, risk-managed trading system with validated edge and calibrated outputs.
   ```

## Phase 3: Review Auto-Suggestions

7. **Process `plans/annotation_review.md`**. For each suggestion:

   **validation_module (medium confidence)**:
   - Read the file. Does it actually validate output quality (not just unit test)?
   - If YES → add the annotation manually
   - If NO (it's a utility/helper) → skip

   **consumer (medium confidence)**:
   - Check if the import relationship is meaningful (not just a transitive re-export)
   - Add the most important 1-3 consumers per file, not all of them

   **enabled_default (low confidence)**:
   - Check if the enable/disable pattern is a real feature flag
   - If YES → add annotation
   - If it's just a variable name → skip

8. **Delete or archive** `plans/annotation_review.md` after processing.

## Phase 4: Add Domain Annotations

This is the critical phase. These annotations cannot be inferred automatically.

9. **Add `@planner:proves` annotations**. For each success criterion in plan.md:
   - Find the file(s) that produce evidence this criterion is met
   - Add `# @planner:proves = crit:sc_<N>` to those files

   Example mapping:
   | Criterion | File | Annotation |
   |-----------|------|------------|
   | sc_1: Calibration error < 5% | validation/calibration_check.py | `# @planner:proves = crit:sc_1` |
   | sc_2: All modules wired | tests/test_integration.py | `# @planner:proves = crit:sc_2` |

   **How to find proof files**:
   - Search for criterion keywords in validation/test directories
   - Check story_registry.json validation_refs
   - Ask the user if uncertain

10. **Add `@planner:mutually_exclusive` annotations**. Identify config flags that must not coexist:
   - Read config files and understand flag semantics
   - Look at story_registry or plan for known conflicts
   - Add paired annotations:
     ```python
     # @planner:config_flag = use_walk_forward
     # @planner:mutually_exclusive = use_cpcv_ga
     ```
   Both files need the annotation (symmetry required).

11. **Add `@planner:metric_type` annotations** for files that produce metrics:
    - `raw` — unprocessed metric (e.g., raw returns)
    - `capped` — bounded metric (e.g., Sharpe capped at 3.0)
    - `transformed` — derived metric (e.g., log returns)
    - `normalized` — scaled metric (e.g., z-scores)

12. **Add `@planner:story` annotations** for files not yet linked to stories:
    - Check story_registry.json code_refs — files listed there already have links
    - For unlisted files, find the most relevant story and add `# @planner:story = US-XXX`

## Phase 5: Validate and Report

13. **Re-validate all annotations**:
    ```bash
    node .agent/skills/iterative-planner/scripts/annotation_parser.mjs --validate
    ```
    Must show 0 errors. Fix any issues.

14. **Re-check traceability**:
    ```bash
    node .agent/skills/iterative-planner/scripts/ontology_serializer.mjs --json
    ```
    Compare to Phase 1 baseline. Key improvements to confirm:
    - `annotation_proves > 0` (criterion proofs added)
    - `criterion_story_links > 0` (stories linked to criteria)
    - All criteria have at least one evidence path

15. **Run the traceability pack** to find remaining gaps:
    ```bash
    node .agent/skills/iterative-planner/scripts/audit_runner.mjs --pack traceability
    ```
    Address any TR-001 (ungrounded criterion) or TR-003 (goal at risk) findings.

16. **Report the final traceability matrix** to the user:

    | Criterion | Stories | Code Refs | Validation | @proves | Status |
    |-----------|---------|-----------|------------|---------|--------|
    | sc_1      | US-005  | model.py  | calib.py   | YES     | FULL   |
    | sc_2      | US-012  | wire.py   | -          | NO      | PARTIAL |

## Phase 6: Commit

17. **Commit the enriched annotations**:
    ```
    chore: consolidate @planner: annotations — add proves/exclusion/metric links
    ```

## Coverage Targets

A well-annotated project should have:
- Every success criterion proven by at least one `@planner:proves` annotation
- Every validation module annotated with `@planner:validation_module`
- All known mutually exclusive flags paired with `@planner:mutually_exclusive`
- Key files linked to stories via `@planner:story`
- Traceability pack reports 0 TR-001 (ungrounded criterion) findings

## Notes

- This workflow is designed to be run by an AI agent WITH the user available for domain questions
- The agent should propose annotations and ask for confirmation before applying
- When uncertain about a `@planner:proves` link, present the candidate and ask
- The annotation_review.md is a starting point, not exhaustive — the agent should also scan for obvious gaps
- Re-run this workflow periodically as the project evolves (new features = new criteria = new annotations needed)
