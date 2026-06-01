---
description: Standard workflow for creating a new CRM pipeline and integrating it into the Tesseract Automation Engine.
---

# /create-pipeline

**Purpose**: To systematically create a new CRM pipeline (e.g. Guest Speakers, Partners), integrating the SQLite store, skills module, and MCP server, without blind boilerplate duplication and with formal behavioural tests.

## Steps

1. **Schema Definition**: Decide the initial schema. Standard pipelines need an `id`, `name`, `email`, `stage`, `notes`, `created_ts`, and `next_followup_ts`.
2. **Store Component**: Create `tesseract_operator/storage/<pipeline_name>_store.py`. Implement standard methods: `add`, `update`, `get`, `list_due`, and `log_interaction` (appending to notes). Use parameterized SQLite queries and enforce datatypes.
3. **Skill Component**: Create `tesseract_operator/skills/<pipeline_name>_skills.py` that exposes the store via MCP interfaces using standard input validation (e.g. Pydantic or type hints). 
4. **Dependency Injection**: Modify `tesseract_operator/mcp_server.py` in `_build_extras` to instantiate the `<Pipeline>Store` and inject it into the `skill_context`. Then register the new tools in the server.
5. **Testing**: Create test suite `tests/test_<pipeline_name>_store.py` ensuring `stage` constraints and `log_interaction` time-stamping work.
6. **Audit**: Run `/safe-change-power` to trigger Red Team and Regression Audits on `mcp_server.py` modification.
