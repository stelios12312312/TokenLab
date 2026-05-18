%% diagnostics.pl — compact semantic findings queries for planner_findings.mjs.
%%
%% These predicates are intentionally advisory-oriented. They classify what the
%% planner already knows into semantic blocks, repairable variance, recovery
%% hints, and next-best actions without adding a second planner.
%%
%% Dynamic facts supplied by JS when available:
%%   diagnostics_gate(From, To)
%%   diagnostics_active_plan_poisoned(true/false)
%%   diagnostics_simple_task(true/false)
%%   diagnostics_full_flow(true/false)
%%   diagnostics_structural_token_feature(true/false)
%%   diagnostics_ui_renderer_surface(true/false)
%%   diagnostics_renderer_contract_explicit(true/false)
%%   diagnostics_visual_render_proof(true/false)
%%   canonicalization_applied(Type, From, To)
%%   project_archetype(Archetype)
%%   story_postcondition_count(Count)
%%   story_conflict_decl_count(Count)
%%   proof_telemetry_mode(present/partial/absent/disabled/unavailable/invalid)
%%   touched_surface(Surface)
%%   task_signal(Signal)
%%   proof_event(ProofType)
%%   artifact_recorded(Path)
%%   diagnostics_pending_high_remediation_count(Count)
%%   diagnostics_remediation_age_days(Days)
%%   diagnostics_adjacency_required(true/false)
%%   diagnostics_adjacency_populated(true/false)
%%   diagnostics_adjacency_explicit_na(true/false)
%%   diagnostics_adjacency_candidate_count(Count)
%%   diagnostics_domain_checklist_required(true/false)
%%   diagnostics_domain_checklist_present(true/false)
%%   diagnostics_domain_checklist_placeholder(true/false)
%%   diagnostics_config_flag_context(true/false)
%%   diagnostics_config_relevance(none/weak/strong)
%%   diagnostics_mutually_exclusive_declared(true/false)
%%   diagnostics_stateful_flow_context(true/false)
%%   diagnostics_story_relevance(none/weak/strong)
%%   diagnostics_scope_degraded(true/false)
%%   diagnostics_scope_degraded_reason(Reason)

telemetry_available :-
    proof_telemetry_mode(present).

telemetry_available :-
    proof_telemetry_mode(partial).

semantic_block(invariant(Name), Detail) :-
    invariant_violated(Name, Detail).

semantic_block(transition_guard, Reason) :-
    diagnostics_gate(From, To),
    missing_guard(From, To, Reason).

semantic_block(story_registry_gap, info(story_registry_missing, 0)) :-
    diagnostics_full_flow(true),
    story_registry_exists(false).

semantic_block(story_registry_gap, info(placeholder_story_registry, Count)) :-
    diagnostics_full_flow(true),
    story_registry_exists(true),
    story_count(Count),
    Count =< 1.

semantic_block(remediation_backlog_gap, info(stale_high_pending_remediation, count_age(Count, Days))) :-
    diagnostics_pending_high_remediation_count(Count),
    Count >= 3,
    diagnostics_remediation_age_days(Days),
    Days >= 14.

repairable_variance(canonicalization(Type), info(From, To)) :-
    canonicalization_applied(Type, From, To).

repairable_variance(story_registry_gap, info(story_registry_missing, 0)) :-
    diagnostics_simple_task(true),
    story_registry_exists(false).

repairable_variance(story_registry_gap, info(placeholder_story_registry, Count)) :-
    diagnostics_simple_task(true),
    story_registry_exists(true),
    story_count(Count),
    Count =< 1.

repairable_variance(advisory(Name), Detail) :-
    invariant_warning(Name, Detail).

repairable_variance(remediation_backlog_gap, info(pending_high_remediation, count_age(Count, Days))) :-
    diagnostics_pending_high_remediation_count(Count),
    Count > 0,
    diagnostics_remediation_age_days(Days),
    Days >= 7,
    \+ semantic_block(remediation_backlog_gap, _).

repairable_variance(adjacency_gap, info(missing_structured_adjacency, count(Count))) :-
    diagnostics_adjacency_required(true),
    diagnostics_adjacency_candidate_count(Count),
    \+ diagnostics_adjacency_populated(true).

repairable_variance(adjacency_gap, info(missing_structured_adjacency, count(Count))) :-
    diagnostics_adjacency_required(true),
    diagnostics_adjacency_candidate_count(Count),
    diagnostics_adjacency_explicit_na(true).

repairable_variance(domain_checklist_gap, info(placeholder_domain_checklist, repo_specific_checks)) :-
    diagnostics_domain_checklist_required(true),
    diagnostics_domain_checklist_present(true),
    diagnostics_domain_checklist_placeholder(true).

repairable_variance(config_fact_gap, info(missing_mutually_exclusive_facts, config_flags)) :-
    diagnostics_config_relevance(strong),
    \+ diagnostics_mutually_exclusive_declared(true).

repairable_variance(story_semantic_gap, info(missing_story_postconditions, stateful_user_flow)) :-
    diagnostics_story_relevance(strong),
    story_registry_exists(true),
    story_postcondition_count(0).

repairable_variance(story_semantic_gap, info(missing_story_conflict_facts, stateful_user_flow)) :-
    diagnostics_story_relevance(strong),
    story_registry_exists(true),
    story_conflict_decl_count(0).

repairable_variance(semantic_substrate_scope, info(scope_degraded, Reason)) :-
    diagnostics_scope_degraded(true),
    diagnostics_scope_degraded_reason(Reason),
    Reason \= none.

repairable_variance(semantic_substrate_hint, info(weak_relevance_hint, config)) :-
    diagnostics_config_relevance(weak).

repairable_variance(semantic_substrate_hint, info(weak_relevance_hint, story_semantics)) :-
    diagnostics_story_relevance(weak).

repairable_variance(structural_token_renderer_gap, info(renderer_contract_missing, explicit_renderer_handling)) :-
    diagnostics_structural_token_feature(true),
    diagnostics_ui_renderer_surface(true),
    \+ diagnostics_renderer_contract_explicit(true).

repairable_variance(structural_token_renderer_gap, info(visual_render_proof_missing, browser_or_visual_proof)) :-
    diagnostics_structural_token_feature(true),
    diagnostics_ui_renderer_surface(true),
    \+ diagnostics_visual_render_proof(true).

repairable_variance(proof_gap, info(missing_visual_evidence, browser_ui)) :-
    telemetry_available,
    touched_surface(browser_ui),
    \+ proof_event(browser_journey),
    \+ proof_event(visual_proof),
    \+ proof_event(manual_observation).

repairable_variance(proof_gap, info(missing_renderer_contract_check, structural_token_output)) :-
    telemetry_available,
    touched_surface(browser_ui),
    task_signal(structural_token_output),
    \+ proof_event(renderer_contract_check).

repairable_variance(proof_gap, info(missing_integration_probe, api_integration)) :-
    telemetry_available,
    touched_surface(api_integration),
    \+ proof_event(integration_smoke),
    \+ proof_event(api_probe),
    \+ proof_event(dry_run).

repairable_variance(proof_gap, info(missing_mutually_exclusive_check, config_flags)) :-
    telemetry_available,
    touched_surface(config_flags),
    task_signal(config_flags_changed),
    \+ proof_event(mutually_exclusive_check).

repairable_variance(proof_gap, info(missing_postcondition_check, stateful_user_flow)) :-
    telemetry_available,
    touched_surface(stateful_user_flow),
    task_signal(stateful_user_flow),
    \+ proof_event(postcondition_check).

repairable_variance(proof_gap, info(missing_temporal_split_check, quant)) :-
    telemetry_available,
    project_archetype(quant),
    touched_surface(quant_modeling),
    task_signal(model_or_signal_change),
    \+ proof_event(temporal_split_check).

repairable_variance(proof_gap, info(missing_leakage_check, quant)) :-
    telemetry_available,
    project_archetype(quant),
    touched_surface(quant_modeling),
    task_signal(model_or_signal_change),
    \+ proof_event(leakage_check).

repairable_variance(proof_gap, info(missing_calibration_evidence, quant)) :-
    telemetry_available,
    project_archetype(quant),
    touched_surface(quant_modeling),
    task_signal(prediction_output_change),
    \+ proof_event(calibration_check),
    \+ proof_event(benchmark_comparison).

repairable_variance(proof_gap, info(missing_backtest_or_parity_evidence, quant)) :-
    telemetry_available,
    project_archetype(quant),
    touched_surface(quant_modeling),
    task_signal(backtest_logic_change),
    \+ proof_event(backtest_run),
    \+ proof_event(live_parity_check).

recommended_recovery(recover_poison_then_lightweight) :-
    planner_hard_policy('impact_over_ritual'),
    diagnostics_active_plan_poisoned(true),
    diagnostics_simple_task(true).

recommended_recovery(recover_poison_then_retry_full) :-
    diagnostics_active_plan_poisoned(true),
    diagnostics_full_flow(true),
    \+ diagnostics_simple_task(true).

recommended_recovery(resolve_semantic_blocks) :-
    semantic_block(_, _).

recommended_recovery(continue_current_flow) :-
    \+ semantic_block(_, _),
    \+ diagnostics_active_plan_poisoned(true).

minimal_repair_item(transition_guard, Reason) :-
    semantic_block(transition_guard, Reason).

minimal_repair_item(story_registry_bootstrap, Detail) :-
    semantic_block(story_registry_gap, Detail).

minimal_repair_item(invariant(Name), Detail) :-
    invariant_violated(Name, Detail).

minimal_repair_item(remediation_backlog_gap, Detail) :-
    semantic_block(remediation_backlog_gap, Detail).

minimal_repair_item(adjacency_gap, Detail) :-
    repairable_variance(adjacency_gap, Detail).

minimal_repair_item(domain_checklist_gap, Detail) :-
    repairable_variance(domain_checklist_gap, Detail).

minimal_repair_item(config_fact_gap, Detail) :-
    repairable_variance(config_fact_gap, Detail).

minimal_repair_item(story_semantic_gap, Detail) :-
    repairable_variance(story_semantic_gap, Detail).

minimal_repair_item(structural_token_renderer_gap, info(renderer_contract_missing, explicit_renderer_handling)) :-
    repairable_variance(structural_token_renderer_gap, info(renderer_contract_missing, explicit_renderer_handling)).

minimal_repair_item(structural_token_renderer_gap, info(visual_render_proof_missing, browser_or_visual_proof)) :-
    repairable_variance(structural_token_renderer_gap, info(visual_render_proof_missing, browser_or_visual_proof)).

minimal_repair_item(proof_gap, Detail) :-
    repairable_variance(proof_gap, Detail).

next_best_action(run_recover_poison) :-
    recommended_recovery(recover_poison_then_lightweight).

next_best_action(resolve_semantic_blocks) :-
    semantic_block(_, _).

next_best_action(run_story_bootstrap) :-
    semantic_block(story_registry_gap, _).

next_best_action(review_stale_high_remediation) :-
    semantic_block(remediation_backlog_gap, _).

next_best_action(review_stale_high_remediation) :-
    repairable_variance(remediation_backlog_gap, _).

next_best_action(populate_adjacency) :-
    repairable_variance(adjacency_gap, _).

next_best_action(fill_domain_checklist) :-
    repairable_variance(domain_checklist_gap, _).

next_best_action(declare_mutually_exclusive_facts) :-
    repairable_variance(config_fact_gap, _).

next_best_action(add_story_postconditions) :-
    repairable_variance(story_semantic_gap, info(missing_story_postconditions, stateful_user_flow)).

next_best_action(declare_story_conflicts) :-
    repairable_variance(story_semantic_gap, info(missing_story_conflict_facts, stateful_user_flow)).

next_best_action(verify_structural_token_renderer) :-
    repairable_variance(structural_token_renderer_gap, _).

next_best_action(record_visual_evidence) :-
    repairable_variance(proof_gap, info(missing_visual_evidence, browser_ui)).

next_best_action(verify_structural_token_renderer) :-
    repairable_variance(proof_gap, info(missing_renderer_contract_check, structural_token_output)).

next_best_action(run_integration_probe) :-
    repairable_variance(proof_gap, info(missing_integration_probe, api_integration)).

next_best_action(verify_mutually_exclusive_flags) :-
    repairable_variance(proof_gap, info(missing_mutually_exclusive_check, config_flags)).

next_best_action(verify_postconditions) :-
    repairable_variance(proof_gap, info(missing_postcondition_check, stateful_user_flow)).

next_best_action(verify_quant_temporal_split) :-
    repairable_variance(proof_gap, info(missing_temporal_split_check, quant)).

next_best_action(verify_quant_leakage_check) :-
    repairable_variance(proof_gap, info(missing_leakage_check, quant)).

next_best_action(verify_quant_calibration) :-
    repairable_variance(proof_gap, info(missing_calibration_evidence, quant)).

next_best_action(verify_quant_backtest_or_parity) :-
    repairable_variance(proof_gap, info(missing_backtest_or_parity_evidence, quant)).

next_best_action(proceed_lightweight) :-
    diagnostics_simple_task(true),
    \+ semantic_block(_, _),
    \+ diagnostics_active_plan_poisoned(true).

next_best_action(proceed_full_flow) :-
    diagnostics_full_flow(true),
    \+ semantic_block(_, _),
    \+ diagnostics_active_plan_poisoned(true).
