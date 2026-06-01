---
description: Queue and send email drafts using the local JSON draft queue
---

# /send-drafts Workflow

## Queue drafts from a template (batch)

```bash
# Queue from template with variable substitution
// turbo-all
python scripts/email_drafter.py queue-template \
    --template ai_fluency_onboarding.md \
    --to "name@example.com" \
    --subject "Your Access to the Tesseract AI Coach" \
    --vars '{"first_name": "Alice"}'
```

## Queue a one-off draft

```bash
python scripts/email_drafter.py queue \
    --to "name@example.com" \
    --subject "Subject" \
    --body "Body text here"
```

## Review before sending

```bash
# List all pending
python scripts/email_drafter.py list

# Preview one
python scripts/email_drafter.py preview --id <draft_id>
```

## Send via Gmail API

```bash
# Dry run (no actual API calls)
python scripts/email_drafter.py send --dry-run

# Create Gmail drafts only (safe — review in Gmail before sending)
python scripts/email_drafter.py send --create-drafts-only

# Send directly (HIGH risk — requires Gmail OAuth token)
python scripts/email_drafter.py send
```

## After sending

```bash
python scripts/email_drafter.py clear-sent
```

## Rules enforced automatically
- Emails from `stelios@thetesseractacademy.com` → no signature (auto-appended by mail client)
- Templates from `docs/email_templates/` are used, not hardcoded prompts
- Drafts stored in `data/email_drafts/` as JSON — inspectable, versionable, replayable
