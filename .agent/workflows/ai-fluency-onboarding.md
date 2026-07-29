---
description: Onboarding participants to the AI Fluency course
---
<!-- planner:host-owned-workflow -->

# AI Fluency Onboarding Workflow

This workflow documents the standard operating procedure for granting participants access to the "Practical AI Fluency for Leaders" course (Course ID `35278`).

## Automated Onboarding

Use the unified `onboard_ai_fluency.py` script. The script automatically handles:
1. Finding or creating the WordPress user.
2. Enrolling them in the AI Fluency course.
3. Drafting the welcome email dynamically depending on if they are a NEW user (includes the securely generated temporary password) or an EXISTING user (reminds them to login using their current credentials).

Replace `<User Email>` and `<User Name>` with the actual details.

```bash
PYTHONPATH=. .venv/bin/python scripts/onboard_ai_fluency.py --email "<User Email>" --name "<User Name>" --live
```

## Email Dispatch & Verification

After running the script, you will receive a Draft ID (e.g., `r-1234`). 

Check your Gmail drafts. As per the automated framework rules (`R-EMAIL-SEND-GATE`), programmatic dispatch of outbound functional emails is blocked and requires manual review.
Review the exact contents of the drafted email, ensure the user details are correct, and push "Send".
