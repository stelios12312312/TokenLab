---
description: Onboarding participants to the Tesseract AI Coach platform
---
<!-- planner:host-owned-workflow -->

# Tesseract AI Coach Onboarding Workflow

This workflow documents the standard operating procedure for granting participants access to the Tesseract AI Coach after they complete a workshop (e.g., AI Fluency).

## Prerequisites

1. You must have a verified list of participants (e.g., from `plans/knowledge/ai_fluency_participants.md`).
2. Participants should be cross-referenced with GoHighLevel to ensure they actually attended the event.

> [!TIP]
> **Existing automation**: `scripts/signup_ai_coach.py` handles the full flow (WP user creation via LearnDash + AI Coach activation). For a single user, create a quick CSV with `email,name` columns and run:
> ```bash
> python scripts/signup_ai_coach.py --input <csv> --live
> ```

## 1. Participant Aggregation

Retrieve the target participants.
If the list needs to be refreshed, use the `/ai-fluency-participants` workflow to pull data from Eventbrite/GHL logic.

## 2. Compose Outreach Emails

When crafting the emails, **STRICTLY FOLLOW** `docs/email_rules.md`:
*   **Voice**: Always use plural ("We are pleased to...", "Our programmes...").
*   **Tone**: Keep it measured and professional. No robotic phrasing ("Dear [First Name]", not "Dear Sir/Madam"). No forced enthusiasm.
*   **Sign-off**: Standard CEO signature block must be used.
*   **CCs**: Ensure Vasileios (`vasileios@thetesseractacademy.com`) and Jordan (`jordan@thetesseractacademy.com`) are always CC'd if replying via Gmail, or include them directly.
*   **Link**: Explicitly provide the member portal: `https://tesseract.academy/tesseract-ai-coach-member/`

### Template Base (English)

```
Subject: Your Access to the Tesseract AI Coach

Hi [First Name],

Hope all is well. As promised, here are your access details for the Tesseract AI Coach.

You can dive straight into the platform using the link below:
https://tesseract.academy/tesseract-ai-coach-member/

If you run into any issues or have questions about using it, just let us know.
```

## 3. Distribution

If automated distribution is requested, draft the emails directly into the user's Gmail using the `GmailConnector` or `scripts/draft_gmail.py` avoiding blind programmatic sends. The user prefers to review drafts.
