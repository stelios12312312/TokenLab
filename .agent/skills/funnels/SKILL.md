---
name: Funnels Knowledge Management
description: Agent protocol for reading, interpreting, and updating marketing funnel documentation.
---

# Funnels Knowledge Base Skill

This skill governs how you interact with funnel documentation located in `plans/knowledge/funnels/`. This applies whenever you are tasked with designing, troubleshooting, or integrating logic related to any funnel (e.g., Eventbrite, GoHighLevel, Facebook Ads, Instantly).

## 1. Information Retrieval
- **Always** consult `plans/knowledge/funnels/index.md` to see the list of active funnels before assuming a system flow.
- Consult the specific funnel document (e.g., `ai-clinic.md`, `ai-fluency.md`) when making changes that interact with that funnel's data flow.

## 2. Mandatory Human Escalation (No Guessing)
When working on a funnel integration, if any part of the flow, system trigger, technical integration, or CRM pipeline mapping is **unclear, ambiguous, or missing** from the documentation:
1. **DO NOT ASSUME OR GUESS.**
2. You **MUST** refer back to the human.
3. Pause your execution and immediately use the `notify_user` tool (or ask directly) with specific questions to clarify the missing information.
4. If a tag name, pipeline name, or sequence detail is unspecified in the documentation, ask the human for the exact expected value.

## 3. Knowledge Persistence
Once the human provides the answer or clarification:
1. You **MUST** update the relevant funnel document in `plans/knowledge/funnels/` to persist this new knowledge.
2. If it's a new funnel altogether, create a new document using the standard template and link it in `plans/knowledge/funnels/index.md`.
3. Preserve the standard template sections (Overview, Traffic Sources, Entry Points, Flow, Integrations, CRM Mapping, Status).
