# Project Health Report
Generated: 2026-06-30T13:02:20.137Z | Commit: aaa45b4 | Analyzers: 5 ran | Time: 0.2s

## ❌ Failures (4)
| # | Analyzer | Finding | Location |
|---|----------|---------|----------|
| 1 | [tokenomics] supply_emissions | Tokenomics scope is present, but the supply/emissions contract is incomplete (missing: supply, emissions, authority). | US-Z1-M3-01 |
| 2 | [tokenomics] vesting_unlocks | Tokenomics scope is present, but vesting/unlock pressure is incomplete (missing: vesting, cliff, buckets). | US-Z1-M3-01 |
| 3 | [tokenomics] incentive_sustainability | Tokenomics scope is present, but incentive sustainability is incomplete (missing: objective, yield_source, abuse, reflexivity). | US-Z1-M3-01 |
| 4 | [tokenomics] liquidity_treasury_governance | Tokenomics scope is present, but liquidity, treasury, and governance authority are incomplete (missing: liquidity, risk_controls). | US-Z1-M3-01 |

## ⚠️ Warnings (126)
| # | Analyzer | Finding | Location | Count |
|---|----------|---------|----------|-------|
| 1 | Documentation Reference Check | Stale reference: `kb_docs/ai_fluency_bootcamp/voice_rules.md` does not exist | .agent/skills/cold-email/SKILL.md:155 | 1 |
| 2 | Documentation Reference Check | Stale reference: `reports/dashboard/fleet_snapshot.yaml` does not exist | .agent/skills/dashboard/SKILL.md:18 | 1 |
| 3 | Documentation Reference Check | Stale reference: `reports/dashboard/site/index.html` does not exist | .agent/skills/dashboard/SKILL.md:18 | 1 |
| 4 | Documentation Reference Check | Stale reference: `tesseract_operator/connectors/elastic.py` does not exist | .agent/skills/elastic-email/SKILL.md:14 | 1 |
| 5 | Documentation Reference Check | Stale reference: `tesseract_operator/skills/elastic_skills.py` does not exist | .agent/skills/elastic-email/SKILL.md:15 | 1 |
| 6 | Documentation Reference Check | Stale reference: `scripts/ghl_email_cleanup.py` does not exist | .agent/skills/elastic-email/SKILL.md:39 | 2 |
| 7 | Documentation Reference Check | Stale reference: `tesseract_operator/connectors/facebook_ads.py` does not exist | .agent/skills/facebook-ads/SKILL.md:10 | 1 |
| 8 | Documentation Reference Check | Stale reference: `tesseract_operator/skills/facebook_ads_skills.py` does not exist | .agent/skills/facebook-ads/SKILL.md:11 | 1 |
| 9 | Documentation Reference Check | Stale reference: `tesseract_operator/connectors/fireflies.py` does not exist | .agent/skills/fireflies/SKILL.md:10 | 1 |
| 10 | Documentation Reference Check | Stale reference: `tesseract_operator/connectors/ghl.py` does not exist | .agent/skills/ghl/SKILL.md:10 | 1 |
| 11 | Documentation Reference Check | Stale reference: `tesseract_operator/skills/ghl_skills.py` does not exist | .agent/skills/ghl/SKILL.md:11 | 1 |
| 12 | Documentation Reference Check | Stale reference: `scripts/ghl_crm_align.py` does not exist | .agent/skills/ghl/SKILL.md:85 | 1 |
| 13 | Documentation Reference Check | Stale reference: `tesseract_operator/connectors/gmail.py` does not exist | .agent/skills/gmail/SKILL.md:10 | 1 |
| 14 | Documentation Reference Check | Stale reference: `tesseract_operator/skills/gmail_skills.py` does not exist | .agent/skills/gmail/SKILL.md:11 | 1 |
| 15 | Documentation Reference Check | Stale reference: `docs/email_rules.md` does not exist | .agent/skills/gmail/SKILL.md:38 | 2 |
| 16 | Documentation Reference Check | Stale reference: `tesseract_operator/connectors/google_calendar.py` does not exist | .agent/skills/google-calendar/SKILL.md:9 | 1 |
| 17 | Documentation Reference Check | Stale reference: `.cursor/rules/iterative-planner.mdc` does not exist | .agent/skills/iterative-planner/MIGRATION.md:58 | 1 |
| 18 | Documentation Reference Check | Stale reference: `.github/copilot-instructions.md` does not exist | .agent/skills/iterative-planner/MIGRATION.md:59 | 1 |
| 19 | Documentation Reference Check | Stale reference: `docs/ive-redesign/15_multi_ide_portability.md` does not exist | .agent/skills/iterative-planner/MIGRATION.md:67 | 1 |
| 20 | Documentation Reference Check | Stale reference: `prolog/project.pl` does not exist | .agent/skills/iterative-planner/MIGRATION.md:507 | 1 |
| 21 | Documentation Reference Check | Stale reference: `.agent/thrashing_thresholds.yaml` does not exist | .agent/skills/iterative-planner/references/thrashing_signals.md:3 | 1 |
| 22 | Documentation Reference Check | Stale reference: `.agent/skills/voice-rules/voice_rules.md` does not exist | .agent/skills/landing-page-copywriter/SKILL.md:57 | 1 |
| 23 | Documentation Reference Check | Stale reference: `tesseract_operator/connectors/heyreach.py` does not exist | .agent/skills/linkedin-outreach/SKILL.md:24 | 1 |
| 24 | Documentation Reference Check | Stale reference: `tesseract_operator/connectors/linkedin_outreach.py` does not exist | .agent/skills/linkedin-outreach/SKILL.md:25 | 1 |
| 25 | Documentation Reference Check | Stale reference: `tesseract_operator/connectors/openclaw.py` does not exist | .agent/skills/openclaw/SKILL.md:9 | 1 |
| 26 | Documentation Reference Check | Stale reference: `tesseract_operator/skills/openclaw_skills.py` does not exist | .agent/skills/openclaw/SKILL.md:10 | 1 |
| 27 | Documentation Reference Check | Stale reference: `tesseract_operator/rules/openclaw.py` does not exist | .agent/skills/openclaw/SKILL.md:11 | 2 |
| 28 | Documentation Reference Check | Stale reference: `tesseract_operator/connectors/paperclip.py` does not exist | .agent/skills/paperclip/SKILL.md:8 | 1 |
| 29 | Documentation Reference Check | Stale reference: `tesseract_operator/skills/paperclip_skills.py` does not exist | .agent/skills/paperclip/SKILL.md:9 | 1 |
| 30 | Documentation Reference Check | Stale reference: `docs/mcp/cursor.md` does not exist | .agent/skills/planner-mcp/SKILL.md:26 | 1 |
| 31 | Documentation Reference Check | Stale reference: `docs/mcp/continue.md` does not exist | .agent/skills/planner-mcp/SKILL.md:27 | 1 |
| 32 | Documentation Reference Check | Stale reference: `docs/mcp/claude_code.md` does not exist | .agent/skills/planner-mcp/SKILL.md:28 | 1 |
| 33 | Documentation Reference Check | Stale reference: `docs/mcp/claude_desktop.md` does not exist | .agent/skills/planner-mcp/SKILL.md:29 | 1 |
| 34 | Documentation Reference Check | Stale reference: `docs/mcp/antigravity.md` does not exist | .agent/skills/planner-mcp/SKILL.md:30 | 1 |
| 35 | Documentation Reference Check | Stale reference: `.agent/interfaces.yaml` does not exist | .agent/skills/planner-mcp/SKILL.md:34 | 1 |
| 36 | Documentation Reference Check | Stale reference: `docs/http/ci_github_actions.md` does not exist | .agent/skills/planner-mcp/SKILL.md:52 | 1 |
| 37 | Documentation Reference Check | Stale reference: `docs/http/ci_gitlab.md` does not exist | .agent/skills/planner-mcp/SKILL.md:53 | 1 |
| 38 | Documentation Reference Check | Stale reference: `docs/http/slack_bot.md` does not exist | .agent/skills/planner-mcp/SKILL.md:54 | 1 |
| 39 | Documentation Reference Check | Stale reference: `docs/http/fleet_dashboard.md` does not exist | .agent/skills/planner-mcp/SKILL.md:55 | 1 |
| 40 | Documentation Reference Check | Stale reference: `docs/http/webhook_pattern.md` does not exist | .agent/skills/planner-mcp/SKILL.md:56 | 1 |
| 41 | Documentation Reference Check | Stale reference: `docs/http/reverse_proxy.md` does not exist | .agent/skills/planner-mcp/SKILL.md:57 | 2 |
| 42 | Documentation Reference Check | Stale reference: `.agent/version.json` does not exist | .agent/skills/planner-mcp/SKILL.md:66 | 3 |
| 43 | Documentation Reference Check | Stale reference: `tesseract_operator/connectors/slack.py` does not exist | .agent/skills/slack/SKILL.md:10 | 1 |
| 44 | Documentation Reference Check | Stale reference: `tesseract_operator/skills/slack_skills.py` does not exist | .agent/skills/slack/SKILL.md:11 | 1 |
| 45 | Documentation Reference Check | Stale reference: `scripts/extract_annotations.mjs` does not exist | .agent/skills/story-verification/SKILL.md:24 | 1 |
| 46 | Documentation Reference Check | Stale reference: `scripts/verify_coverage.mjs` does not exist | .agent/skills/story-verification/SKILL.md:25 | 1 |
| 47 | Documentation Reference Check | Stale reference: `scripts/verify_obligations.mjs` does not exist | .agent/skills/story-verification/SKILL.md:26 | 1 |
| 48 | Documentation Reference Check | Stale reference: `scripts/report_generator.mjs` does not exist | .agent/skills/story-verification/SKILL.md:27 | 1 |
| 49 | Documentation Reference Check | Stale reference: `prolog/story_rules.pl` does not exist | .agent/skills/story-verification/SKILL.md:28 | 1 |
| 50 | Documentation Reference Check | Stale reference: `tests/test_story_verification.mjs` does not exist | .agent/skills/story-verification/SKILL.md:33 | 1 |
| 51 | Documentation Reference Check | Stale reference: `tesseract_operator/connectors/telegram.py` does not exist | .agent/skills/telegram/SKILL.md:10 | 1 |
| 52 | Documentation Reference Check | Stale reference: `tesseract_operator/skills/telegram_skills.py` does not exist | .agent/skills/telegram/SKILL.md:11 | 1 |
| 53 | Documentation Reference Check | Stale reference: `tesseract_operator/connectors/trello.py` does not exist | .agent/skills/trello/SKILL.md:10 | 1 |
| 54 | Documentation Reference Check | Stale reference: `tesseract_operator/skills/trello_skills.py` does not exist | .agent/skills/trello/SKILL.md:11 | 1 |
| 55 | Documentation Reference Check | Stale reference: `tesseract_operator/connectors/whatsapp.py` does not exist | .agent/skills/whatsapp/SKILL.md:11 | 1 |
| 56 | Documentation Reference Check | Stale reference: `tesseract_operator/skills/whatsapp_skills.py` does not exist | .agent/skills/whatsapp/SKILL.md:12 | 1 |
| 57 | Documentation Reference Check | Stale reference: `tesseract_operator/connectors/zapier.py` does not exist | .agent/skills/zapier/SKILL.md:9 | 1 |
| 58 | Documentation Reference Check | Stale reference: `tesseract_operator/skills/zapier_skills.py` does not exist | .agent/skills/zapier/SKILL.md:10 | 1 |
| 59 | Documentation Reference Check | Stale reference: `data/active_tasks.json` does not exist | .agent/workflows/active-tasks.md:62 | 1 |
| 60 | Documentation Reference Check | Stale reference: `scripts/refresh_active_tasks.py` does not exist | .agent/workflows/active-tasks.md:63 | 1 |
| 61 | Documentation Reference Check | Stale reference: `docs/PENDING.md` does not exist | .agent/workflows/add-task.md:47 | 1 |
| 62 | Documentation Reference Check | Stale reference: `reports/ai_clinic_participants_enriched.csv` does not exist | .agent/workflows/ai-clinic-participants.md:22 | 1 |
| 63 | Documentation Reference Check | Stale reference: `scripts/signup_ai_coach.py` does not exist | .agent/workflows/ai-coach-onboarding.md:15 | 1 |
| 64 | Documentation Reference Check | Stale reference: `scripts/draft_gmail.py` does not exist | .agent/workflows/ai-coach-onboarding.md:51 | 1 |
| 65 | Documentation Reference Check | Stale reference: `reports/ai_fluency_participants.csv` does not exist | .agent/workflows/ai-fluency-participants.md:19 | 1 |
| 66 | Documentation Reference Check | Stale reference: `reports/brand_compliance_audit.json` does not exist | .agent/workflows/brand-compliance-audit.md:28 | 1 |
| 67 | Documentation Reference Check | Stale reference: `kb_docs/brand_rules.yaml` does not exist | .agent/workflows/brand-compliance-audit.md:57 | 1 |
| 68 | Documentation Reference Check | Stale reference: `kb_docs/ai_fluency_bootcamp/brand_rules.yaml` does not exist | .agent/workflows/brand-compliance-audit.md:57 | 1 |
| 69 | Documentation Reference Check | Stale reference: `recipes/campaign-health-check/README.md` does not exist | .agent/workflows/campaign-health-check.md:84 | 1 |
| 70 | Documentation Reference Check | Stale reference: `scripts/contextual_draft_and_enrich.py` does not exist | .agent/workflows/check-unanswered.md:84 | 1 |
| 71 | Documentation Reference Check | Stale reference: `data/campaigns/competitor_swipe_file.json` does not exist | .agent/workflows/competitor-intel.md:4 | 1 |
| 72 | Documentation Reference Check | Stale reference: `.agent/ontology/facts/conventions.yaml` does not exist | .agent/workflows/conventions.md:17 | 1 |
| 73 | Documentation Reference Check | Stale reference: `reports/conventions/lifecycle_log.yaml` does not exist | .agent/workflows/conventions.md:83 | 1 |
| 74 | Documentation Reference Check | Stale reference: `tesseract_operator/marketing/campaign_contract.py` does not exist | .agent/workflows/create-ads.md:28 | 1 |
| 75 | Documentation Reference Check | Stale reference: `recipes/fb-ads-provisioning/ad_draft_review.html` does not exist | .agent/workflows/create-ads.md:47 | 1 |
| 76 | Documentation Reference Check | Stale reference: `scripts/generate_ad_draft.py` does not exist | .agent/workflows/create-ads.md:82 | 1 |
| 77 | Documentation Reference Check | Stale reference: `scripts/provision_dynamic_ads.py` does not exist | .agent/workflows/create-ads.md:83 | 1 |
| 78 | Documentation Reference Check | Stale reference: `scripts/review_ads.py` does not exist | .agent/workflows/create-ads.md:84 | 1 |
| 79 | Documentation Reference Check | Stale reference: `tesseract_operator/mcp_server.py` does not exist | .agent/workflows/create-pipeline.md:14 | 1 |
| 80 | Documentation Reference Check | Stale reference: `scripts/delete_bounced_fast.py` does not exist | .agent/workflows/fast-bounce-delete.md:21 | 1 |
| 81 | Documentation Reference Check | Stale reference: `recipes/marketing_playbooks.json` does not exist | .agent/workflows/launch-campaign.md:9 | 1 |
| 82 | Documentation Reference Check | Stale reference: `tesseract_operator/storage/persona_store.py` does not exist | .agent/workflows/lead_context_aggregation.md:18 | 1 |
| 83 | Documentation Reference Check | Stale reference: `wp_assets/manifest.json` does not exist | .agent/workflows/migrate-page.md:117 | 1 |
| 84 | Documentation Reference Check | Stale reference: `.agent/ontology/facts.pl` does not exist | .agent/workflows/ontology.md:11 | 2 |
| 85 | Documentation Reference Check | Stale reference: `.agent/recipe_fleet.config.yaml` does not exist | .agent/workflows/recipe-fleet-audit.md:7 | 1 |
| 86 | Documentation Reference Check | Stale reference: `recipes/fb-ads-provisioning/ads_review.html` does not exist | .agent/workflows/review-ads.md:28 | 1 |
| 87 | Documentation Reference Check | Stale reference: `.agent/sidekick.config.example.yaml` does not exist | .agent/workflows/sidekick.md:11 | 1 |
| 88 | Documentation Reference Check | Stale reference: `docs/ipbs-recommendations.md` does not exist | .agent/workflows/sme-improvement.md:200 | 1 |
| 89 | Documentation Reference Check | Stale reference: `docs/evolution-trader-recommendations.md` does not exist | .agent/workflows/sme-improvement.md:201 | 1 |
| 90 | Orphaned Capability Check | Orphaned capability detected: `annotation_hints.mjs` (.agent/skills/iterative-planner/scripts/annotation_hints.mjs) | .agent/skills/iterative-planner/scripts/annotation_hints.mjs | 1 |
| 91 | Orphaned Capability Check | Orphaned capability detected: `annotation_quality.mjs` (.agent/skills/iterative-planner/scripts/annotation_quality.mjs) | .agent/skills/iterative-planner/scripts/annotation_quality.mjs | 1 |
| 92 | Orphaned Capability Check | Orphaned capability detected: `autonomous_driver.mjs` (.agent/skills/iterative-planner/scripts/autonomous_driver.mjs) | .agent/skills/iterative-planner/scripts/autonomous_driver.mjs | 1 |
| 93 | Orphaned Capability Check | Orphaned capability detected: `behavior_report.mjs` (.agent/skills/iterative-planner/scripts/behavior_report.mjs) | .agent/skills/iterative-planner/scripts/behavior_report.mjs | 1 |
| 94 | Orphaned Capability Check | Orphaned capability detected: `check_profile.mjs` (.agent/skills/iterative-planner/scripts/check_profile.mjs) | .agent/skills/iterative-planner/scripts/check_profile.mjs | 1 |
| 95 | Orphaned Capability Check | Orphaned capability detected: `contract_reliability.mjs` (.agent/skills/iterative-planner/scripts/contract_reliability.mjs) | .agent/skills/iterative-planner/scripts/contract_reliability.mjs | 1 |
| 96 | Orphaned Capability Check | Orphaned capability detected: `episode_source_harvest.mjs` (.agent/skills/iterative-planner/scripts/episode_source_harvest.mjs) | .agent/skills/iterative-planner/scripts/episode_source_harvest.mjs | 1 |
| 97 | Orphaned Capability Check | Orphaned capability detected: `gate_false_failure_ledger.mjs` (.agent/skills/iterative-planner/scripts/gate_false_failure_ledger.mjs) | .agent/skills/iterative-planner/scripts/gate_false_failure_ledger.mjs | 1 |
| 98 | Orphaned Capability Check | Orphaned capability detected: `gate_idempotence_check.mjs` (.agent/skills/iterative-planner/scripts/gate_idempotence_check.mjs) | .agent/skills/iterative-planner/scripts/gate_idempotence_check.mjs | 1 |
| 99 | Orphaned Capability Check | Orphaned capability detected: `harvest_real_telemetry.mjs` (.agent/skills/iterative-planner/scripts/harvest_real_telemetry.mjs) | .agent/skills/iterative-planner/scripts/harvest_real_telemetry.mjs | 1 |
| 100 | Orphaned Capability Check | Orphaned capability detected: `pre_push_conformance.mjs` (.agent/skills/iterative-planner/scripts/hooks/pre_push_conformance.mjs) | .agent/skills/iterative-planner/scripts/hooks/pre_push_conformance.mjs | 1 |
| 101 | Orphaned Capability Check | Orphaned capability detected: `ive_packet_validator.mjs` (.agent/skills/iterative-planner/scripts/ive_packet_validator.mjs) | .agent/skills/iterative-planner/scripts/ive_packet_validator.mjs | 1 |
| 102 | Orphaned Capability Check | Orphaned capability detected: `ive_program_intake.mjs` (.agent/skills/iterative-planner/scripts/ive_program_intake.mjs) | .agent/skills/iterative-planner/scripts/ive_program_intake.mjs | 1 |
| 103 | Orphaned Capability Check | Orphaned capability detected: `ive_release_handoff.mjs` (.agent/skills/iterative-planner/scripts/ive_release_handoff.mjs) | .agent/skills/iterative-planner/scripts/ive_release_handoff.mjs | 1 |
| 104 | Orphaned Capability Check | Orphaned capability detected: `ive_user_verdict.mjs` (.agent/skills/iterative-planner/scripts/ive_user_verdict.mjs) | .agent/skills/iterative-planner/scripts/ive_user_verdict.mjs | 1 |
| 105 | Orphaned Capability Check | Orphaned capability detected: `knowledge_packs.mjs` (.agent/skills/iterative-planner/scripts/knowledge_packs.mjs) | .agent/skills/iterative-planner/scripts/knowledge_packs.mjs | 1 |
| 106 | Orphaned Capability Check | Orphaned capability detected: `knowledge_triggers.mjs` (.agent/skills/iterative-planner/scripts/knowledge_triggers.mjs) | .agent/skills/iterative-planner/scripts/knowledge_triggers.mjs | 1 |
| 107 | Orphaned Capability Check | Orphaned capability detected: `ontology_namespace_check.mjs` (.agent/skills/iterative-planner/scripts/ontology_namespace_check.mjs) | .agent/skills/iterative-planner/scripts/ontology_namespace_check.mjs | 1 |
| 108 | Orphaned Capability Check | Orphaned capability detected: `ontology_write.mjs` (.agent/skills/iterative-planner/scripts/ontology_write.mjs) | .agent/skills/iterative-planner/scripts/ontology_write.mjs | 1 |
| 109 | Orphaned Capability Check | Orphaned capability detected: `persona_manifest_ci.mjs` (.agent/skills/iterative-planner/scripts/persona_manifest_ci.mjs) | .agent/skills/iterative-planner/scripts/persona_manifest_ci.mjs | 1 |
| 110 | Orphaned Capability Check | Orphaned capability detected: `persona_manifest_verify.mjs` (.agent/skills/iterative-planner/scripts/persona_manifest_verify.mjs) | .agent/skills/iterative-planner/scripts/persona_manifest_verify.mjs | 1 |
| 111 | Orphaned Capability Check | Orphaned capability detected: `project_ive.mjs` (.agent/skills/iterative-planner/scripts/project_ive.mjs) | .agent/skills/iterative-planner/scripts/project_ive.mjs | 1 |
| 112 | Orphaned Capability Check | Orphaned capability detected: `recipe_discovery.mjs` (.agent/skills/iterative-planner/scripts/recipe_discovery.mjs) | .agent/skills/iterative-planner/scripts/recipe_discovery.mjs | 1 |
| 113 | Orphaned Capability Check | Orphaned capability detected: `reflection_renderer.mjs` (.agent/skills/iterative-planner/scripts/reflection_renderer.mjs) | .agent/skills/iterative-planner/scripts/reflection_renderer.mjs | 1 |
| 114 | Orphaned Capability Check | Orphaned capability detected: `replay_telemetry.mjs` (.agent/skills/iterative-planner/scripts/replay_telemetry.mjs) | .agent/skills/iterative-planner/scripts/replay_telemetry.mjs | 1 |
| 115 | Orphaned Capability Check | Orphaned capability detected: `review_intake.mjs` (.agent/skills/iterative-planner/scripts/review_intake.mjs) | .agent/skills/iterative-planner/scripts/review_intake.mjs | 1 |
| 116 | Orphaned Capability Check | Orphaned capability detected: `semantic_map.mjs` (.agent/skills/iterative-planner/scripts/semantic_map.mjs) | .agent/skills/iterative-planner/scripts/semantic_map.mjs | 1 |
| 117 | Orphaned Capability Check | Orphaned capability detected: `snapshot_branch_protection.mjs` (.agent/skills/iterative-planner/scripts/snapshot_branch_protection.mjs) | .agent/skills/iterative-planner/scripts/snapshot_branch_protection.mjs | 1 |
| 118 | Orphaned Capability Check | Orphaned capability detected: `verification_metrics.mjs` (.agent/skills/iterative-planner/scripts/verification_metrics.mjs) | .agent/skills/iterative-planner/scripts/verification_metrics.mjs | 1 |
| 119 | Orphaned Capability Check | Orphaned capability detected: `workspace_artifact_inventory.mjs` (.agent/skills/iterative-planner/scripts/workspace_artifact_inventory.mjs) | .agent/skills/iterative-planner/scripts/workspace_artifact_inventory.mjs | 1 |
| 120 | [tokenomics] legal_regulatory_boundary | Tokenomics scope is present, but the legal/regulatory review boundary is incomplete (missing: owner, jurisdiction, not_legal_advice). | US-Z1-M3-01 | 1 |
| 121 | [traceability] traceability | Story has code but no traceability to goals: Provider recirculation rate | US-Z1-M3-02 | 1 |
| 122 | [traceability] traceability | Story has code but no traceability to goals: Epoch pipeline reordering _AR top-up before settlement_ | US-Z1-M3-04 | 1 |
| 123 | [traceability] traceability | Story has code but no traceability to goals: Discrete VRP + CIP pools with waterfall priority | US-Z1-M3-05 | 1 |
| 124 | [traceability] traceability | Story has code but no traceability to goals: Governance staking as Z1U sink | US-Z1-M3-06 | 1 |
| 125 | [traceability] traceability | Story has code but no traceability to goals: Creator cohort with CIP distribution and recirculation | US-Z1-M3-07 | 1 |
| 126 | [traceability] traceability | Story has code but no traceability to goals: Validator cohort with VRP rewards | US-Z1-M3-08 | 1 |

## ℹ️ Info (1)
| # | Analyzer | Finding | Location | Count |
|---|----------|---------|----------|-------|
| 1 | Parity Registry Check | No parity registry found. Consider creating plans/knowledge/parity-registry.md. | /Users/stylianoskampakis/Dropbox (Personal)/Freelance/TokenLab/plans/knowledge/parity-registry.md | 1 |

## Summary
- **Fail**: 4 | **Warn**: 126 | **Info**: 1
- Time: 0.2s
