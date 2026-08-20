# Iterative Planner Scripts Registry

This document serves as a registry for all utility scripts used by the Iterative Planner skill.

## Complete Scripts Directory

| Script Name | Purpose |
|-------------|---------|
| `ab_task_benchmark.mjs` | Utility script supporting planner operations. |
| `advise.mjs` | Advisory utility for providing context-aware recommendations. |
| `annotation_assist.mjs` | Interactive tool to assist with creating and updating @planner annotations. |
| `annotation_hints.mjs` | Provides hints and validation for @planner annotations in source files. |
| `annotation_parser.mjs` | Core parser for extracting @planner annotations from source files. |
| `annotation_quality.mjs` | Analyzes the quality and completeness of @planner annotations. |
| `app_dev_tesseract_check.mjs` | Validation tool for Tesseract-based application development. |
| `audit_runner.mjs` | Core execution engine for running red-team, regression, and user-story audits. |
| `autocoder_metrics.mjs` | Collects IVE/autocoder proof, close-evidence, lifecycle, and telemetry metrics. |
| `autonomous_ticket_delivery.mjs` | Preflights one explicitly selected production Program ticket, spends zero invocations when blocked, otherwise runs once in an isolated Git worktree and emits sanitized diagnostics plus a parent-countersigned artifact grade and receipt without merging or remote mutation. |
| `autonomous_driver.mjs` | Orchestrator for running the planner in autonomous batch mode. |
| `autonomy_leash.mjs` | Safety leash and budget controls for autonomous execution. |
| `batch.mjs` | Handles batch processing for planner operations. |
| `behavior_report.mjs` | Builds behavior-report and scoreboard-facing summaries from autocoder metrics. |
| `blast_radius.mjs` | Analyzes the blast radius of code changes to identify impacted files. |
| `bootstrap.mjs` | Main entrypoint for creating, status checking, and resuming planner sessions. |
| `bootstrap_registry.mjs` | Initializes various registries for the skill. |
| `check_profile.mjs` | Utility to check the active semantic profile and verification obligations. |
| `checklist_runner.mjs` | Executes and validates yaml-based domain checklists. |
| `claims_evidence_validate.mjs` | Validates user-visible claims and evidence against success criteria. |
| `close_guard.mjs` | Ensures all invariants, stories, and checks are satisfied before close. |
| `close_signals.mjs` | Manages signals for plan closure. |
| `complexity_budget.mjs` | Asserts files changed, lines added/removed, and new abstractions stay within budget. |
| `context_packet.mjs` | Assembles context packets for LLM prompts and task routing. |
| `contract_reliability.mjs` | Validates reliability of contracts between components. |
| `convention_inducer.mjs` | Induces project conventions. |
| `conventions.mjs` | Core conventions logic. |
| `decision_anchors.mjs` | Manages decision anchors and logs key architectural choices. |
| `delivery_receipt_assemble.mjs` | Assembles the final delivery receipt summarizing all work and proof. |
| `dispatcher_v1.mjs` | Legacy dispatcher for handling planner events. |
| `episode_source_harvest.mjs` | Harvests source code episodes and trace snippets for the knowledge base. |
| `error_explainer.mjs` | Explains errors encountered during tasks. |
| `escalation_check.mjs` | Checks for retro recurrences, advisor escalations, and active blockers. |
| `evidence_preflight.mjs` | Read-only diagnostics for hotspot PLAN/REFLECT/VALIDATE evidence gates before running hard transitions. |
| `fresh_context_reviewer.mjs` | Performs post-execution review of the fresh context. |
| `gate_compliance.mjs` | Checks and reports compliance with the planner gate transition history. |
| `gate_false_failure_ledger.mjs` | Tracks and manages false-failure records to bypass flaky gate checks. |
| `gate_idempotence_check.mjs` | Ensures gate transition scripts can be rerun safely without side effects. |
| `gate_prepare.mjs` | Prepares transition gates. |
| `gate_survival.mjs` | Diagnostic tool for recovering from failed or blocked gate transitions. |
| `generate_tests.mjs` | Generates tests automatically. |
| `github_ticket_review.mjs` | Intakes, reviews, and publishes local Program Packet tickets to GitHub. |
| `harvest_real_telemetry.mjs` | Harvests real telemetry from test runs and tool usage. |
| `ideation_quality_benchmark.mjs` | Utility script supporting planner operations. |
| `incident_contract.mjs` | Defines and validates contracts for incident response and hotfixes. |
| `insight_velocity_report.mjs` | Generates reports on insight velocity and planning efficiency. |
| `intent_contract_bootstrap.mjs` | Bootstraps the intent contract describing user expectations and deliverables. |
| `ive_packet_validator.mjs` | Validates IVE packets against schemas. |
| `ive_program_intake.mjs` | Intakes high-level programs into the IVE workspace. |
| `ive_release_handoff.mjs` | Coordinates the handoff and verification of a release candidate. |
| `ive_user_verdict.mjs` | Collects and records user verdicts on executed tasks. |
| `journal.mjs` | Maintains a running journal of planner actions and outcomes. |
| `knowledge_benchmark.mjs` | Benchmarks the knowledge base against common mistakes and patterns. |
| `knowledge_packs.mjs` | Manages reusable knowledge packs and lessons learned. |
| `knowledge_resolver.mjs` | Resolves relevant knowledge, gotchas, and patterns for the active goal. |
| `knowledge_triggers.mjs` | Triggers relevant knowledge suggestions based on file modifications. |
| `migrate.mjs` | CLI tool for single-project and fleet setup, upgrade, and version migration. |
| `ontology_cli.mjs` | CLI interface for ontology tasks. |
| `ontology_context.mjs` | Provides ontology context to tasks. |
| `ontology_inducer.mjs` | Induces ontologies from current state. |
| `ontology_namespace_check.mjs` | Validates ontology namespaces and namespaces mappings. |
| `ontology_serializer.mjs` | Serializes active plan state, stories, and facts into Prolog format. |
| `ontology_write.mjs` | Writes facts and rules to the Prolog ontology files. |
| `orient.mjs` | Orients the planner context. |
| `pack_contract_validate.mjs` | Validates contracts for persona and audit packs. |
| `persona_adapt.mjs` | Scans the workspace to adapt and apply domain persona roles. |
| `persona_execute.mjs` | Executes persona-specific checks and audit guidelines. |
| `persona_manifest_ci.mjs` | Validates the persona manifest in CI pipelines. |
| `plan_artifact_renderer.mjs` | Renders plan artifacts into beautiful human-readable formats. |
| `plan_inspector.mjs` | Inspects the active plan. |
| `plan_similarity.mjs` | Evaluates plan similarity. |
| `planner.mjs` | Main entrypoint for general planner orchestration and subcommands. |
| `planner_findings.mjs` | Synthesizes findings, warnings, and errors across the plan. |
| `planner_hygiene.mjs` | Runs hygiene checks on the plan directory and state. |
| `planner_preflight.mjs` | Runs preflight checks to classify goals and recommend the planning route. |
| `planner_score_health_closeout.mjs` | Runs the local planner score-health closeout sequence, requiring Program Packet/Ticket Intake Receipt proof plus behavior, autocoder, IV, ritual, scoreboard, final conformance, and residual-risk interpretation. |
| `pre-commit-hook.sh` | Utility script supporting planner operations. |
| `pre_push_conformance.mjs` | Git pre-push hook to prevent pushing to main branch when IVE conformance is red. |
| `pre_commit_policy.mjs` | Enforces pre-commit policies for the repository. |
| `program_manager.mjs` | Roadmap and program orchestrator for managing epics and tickets, including dry-run-first explicit revival of deferred tickets. |
| `project.mjs` | Project-level planner utilities. |
| `project_health.mjs` | Scans the codebase for stale documentation references, orphaned scripts, and config gaps. |
| `project_ive.mjs` | Workspace integration script for IVE. |
| `prolog_value_audit.mjs` | Audits Prolog values and terms for consistency. |
| `real_telemetry_false_reds.mjs` | Identifies and filters false-red telemetry signals. |
| `recipe_bootstrap.mjs` | Bootstraps deterministic recipe registries and runner contracts. |
| `recipe_discovery.mjs` | Proposes and reviews candidate recipes from prompts. |
| `recipe_fleet_audit.mjs` | Audits the recipe fleet. |
| `recipe_resolver.mjs` | Resolves candidate recipes for execution. |
| `recipe_runner.mjs` | Executes approved recipes against the workspace. |
| `recipe_validate.mjs` | Validates recipes. |
| `reflection_guide.mjs` | Guides the reflection phase. |
| `reflection_renderer.mjs` | Renders the reflection guide. |
| `replay_telemetry.mjs` | Replays telemetry logs to diagnose failures. |
| `retro_registry.mjs` | Manages the retrospective registry of past mistakes and preventions. |
| `reuse_before_create.mjs` | Enforces the reuse of existing modules before creating new ones. |
| `review_intake.mjs` | Intakes tickets and code changes for review. |
| `ripple_check.mjs` | Checks for downstream ripple effects of code modifications. |
| `ritual_lint.mjs` | Lints plan rituals. |
| `ritual_replay.mjs` | Replays and analyzes planning rituals. |
| `rubric_admin_runner.mjs` | Runs administrative rubrics and compliance checks. |
| `rule_engine.mjs` | Prolog-backed rule engine for checking invariants, stories, and conflicts. |
| `scoreboard.mjs` | Displays planning performance and efficiency metrics. |
| `security_audit.mjs` | Audits plan for security issues. |
| `seeded_defect_harness.mjs` | Harness for seeding and testing defect detection capabilities. |
| `semantic_maintenance.mjs` | Performs semantic maintenance on stories and ontologies. |
| `semantic_map.mjs` | Generates and maintains a semantic map of the codebase. |
| `sidekick.mjs` | Provides sidekick features. |
| `snapshot_branch_protection.mjs` | Captures branch protection settings for the repository. |
| `story_cli.mjs` | CLI for managing stories. |
| `story_registry.mjs` | Manages the user story registry, validation, and story verification. |
| `story_registry_bootstrap.mjs` | Bootstraps a new user story registry with schemas and templates. |
| `substrate_check.mjs` | Checks substrate logic. |
| `task_intake.mjs` | Handles incoming tasks. |
| `telemetry.mjs` | Core telemetry client for capturing tool and command execution. |
| `test_baseline.mjs` | Establishes and verifies the test suite baseline. |
| `test_run_record.mjs` | Records test runs. |
| `thrashing_detector.mjs` | Detects and flags loop thrashing or repetitive edits. |
| `trace_auditor.mjs` | Audits execution traces for correctness and leakage. |
| `transition.mjs` | Main gateway script for executing state transitions (e.g. explore-to-plan). |
| `ttinsights_report.mjs` | Generates insights on time-to-insight and planning velocity. |
| `validate-plan.mjs` | Lints and validates the structure and content of plan.md. |
| `validate_mini_reflection.mjs` | Validates mini-reflections. |
| `validate_reflection.mjs` | Validates full reflections. |
| `verification_matrix.mjs` | Lints and validates the plan's verification matrix. |
| `verification_metrics.mjs` | Collects metrics on verification coverage and results. |
| `verification_runner.mjs` | Runs planned verification commands and records results. |
| `verification_strategy.mjs` | Handles verification strategies. |
| `verify_gate.mjs` | Programmatic JavaScript gate library plus explicit planning-only/legacy diagnostics; ordinary CLI use delegates to authoritative `transition.mjs --dry-run`. |
| `verify_manifest.mjs` | Validates the planner manifest. |
| `verify_stories.mjs` | Checks user story coverage and reports gaps. |
| `visualize_wrapper.mjs` | Wrapper for visualizations. |
| `work_order_validate.mjs` | Utility script supporting planner operations. |
| `work_preflight.mjs` | Preflight checks for work execution. |
| `workflow.mjs` | Core workflow execution engine. |
| `workspace_artifact_inventory.mjs` | Read-only inventory of registered workspace roots, stale paths, remap candidates, and planner artifacts. |
