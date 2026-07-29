---
description: Store an active task — the agent parses what the user says and writes it to PENDING.md + optionally GHL
---
<!-- planner:host-owned-workflow -->

# /add-task Workflow

When the user says something like "store this as an active task", "remember to follow up with X", or "add a task to contact Y", follow this workflow.

---

## Step 1: Extract Task Details

Parse the user's message for these fields:

| Field | Required | Example |
|-------|----------|---------|
| **description** | Yes | "Follow up with proposal", "Send brochure" |
| **contact** | Yes | Person's name |
| **due date** | No | YYYY-MM-DD format. If relative ("next week", "in 10 days"), convert to absolute date. |
| **email** | No | Contact's email if mentioned |
| **also GHL** | No | If user says "also in GHL" or "sync to CRM", set `--ghl` |

If any required field is missing, ask the user before proceeding.

---

## Step 2: Store the Task

// turbo
```bash
cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
python scripts/refresh_active_tasks.py \
  --add "DESCRIPTION" \
  --contact "CONTACT_NAME" \
  --due YYYY-MM-DD \
  --email "EMAIL" \
  --ghl   # only if user wants GHL sync
```

Replace the placeholders with the extracted values. Omit `--email`, `--due`, or `--ghl` if not applicable.

---

## Step 3: Confirm to User

Show what was stored:
- The line added to `docs/PENDING.md`
- Whether a GHL task was also created (if `--ghl` was used)
- The due date (or "no date" if none specified)

---

## Marking Tasks as Done

When the user says "mark X as done" or "X is done":

// turbo
```bash
cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
python scripts/refresh_active_tasks.py --done "CONTACT_NAME"
```

---

## Viewing Active Tasks

When the user asks "what's active?" or "show my tasks":

// turbo
```bash
cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
python scripts/refresh_active_tasks.py --list
```

If the cache is stale (>4 hours), refresh first:
```bash
python scripts/refresh_active_tasks.py --summary
```

---

## Examples

**User says**: "Remember to follow up with Maria next Thursday about the workshop"
```bash
python scripts/refresh_active_tasks.py --add "Follow up about the workshop" --contact "Maria" --due 2026-03-26
```

**User says**: "Store a task: send Alice the AI brochure, her email is alice@acme.com, also add it to GHL"
```bash
python scripts/refresh_active_tasks.py --add "Send AI brochure" --contact "Alice" --email "alice@acme.com" --ghl
```

**User says**: "Alice is done, mark it"
```bash
python scripts/refresh_active_tasks.py --done "Alice"
```
