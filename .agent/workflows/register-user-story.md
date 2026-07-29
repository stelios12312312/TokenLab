---
description: Register a new user story in the registry to represent a user request, feature, or task capability.
---

# /register-user-story Workflow

> **Invoke with**: `/register-user-story`

Guides operators and agent assistants in eliciting, formatting, registering, and validating a new user story using the programmatic `story_cli.mjs` tool.

---

## When to run
- The user makes a request to implement a new feature, capability, or non-trivial change.
- A new project plan is being initialized and requires custom user stories.
- An audit gap shows missing story coverage.

---

## Step 1: Elicit User Story Details from the User
Before registering the story, ensure you have the required details:
1. **Title**: A clear summary of the feature/capability.
2. **Narrative/Description**: Structured as:
   - **As a** `<user/role>`
   - **I want** `<the feature/need>`
   - **So that** `<the outcome/value>`
3. **Priority**: `HIGH`, `MEDIUM`, or `LOW`.
4. **Acceptance Criteria**: List of specific, verifiable conditions that define completion.

Ask the user: *"Would you like to register this request as a user story?"* and confirm these details.

---

## Step 2: Register the User Story programmatically
Run the `story_cli.mjs` tool to write the new user story to `reports/user_story_audit/story_registry.json`.

```bash
node .agent/skills/iterative-planner/scripts/story_cli.mjs new "Title of the Story" \
  --priority "MEDIUM" \
  --description "As a... I want... So that..." \
  --acceptance "Criterion 1; Criterion 2; Criterion 3"
```

*Note: The CLI tool automatically generates a collision-free ID and appends the story to the registry.*

---

## Step 3: Verify the Registration and Invariants
After registering the story, run the following verification steps to ensure no invariants are violated:

1. **Verify story registry coverage and gaps**:
   ```bash
   node .agent/skills/iterative-planner/scripts/rule_engine.mjs verify-stories
   ```
2. **Check formal Prolog invariants**:
   ```bash
   node .agent/skills/iterative-planner/scripts/rule_engine.mjs check-invariants
   ```
3. **If in a plan context**, make sure to link the new story to your plan's `Success Criteria` and `Verification Strategy` matrix.
