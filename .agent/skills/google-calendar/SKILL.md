---
description: How to manage Google Calendar events via the Tesseract operator
---

# Google Calendar — Reference Skill

## Authentication
- OAuth2 via Gmail service credentials
- Connector: `tesseract_operator/connectors/google_calendar.py`

## Integration Points
Google Calendar is used for scheduling reminders and events:
- Scheduling follow-up calls with leads
- Creating event reminders with CC recipients
- Cross-referencing with Fireflies/Gmail for meeting context

## Usage Pattern
```python
cal = ctx.extras["google_calendar"]
# Create an event
cal.create_event(
    summary="Follow-up: Vogiatzoglou",
    start="2026-03-19T07:00:00",
    end="2026-03-19T07:30:00",
    timezone="Europe/London",
    attendees=["vasileios@thetesseractacademy.com"],
)
```

## Known Gotchas
1. Uses the same OAuth credentials as Gmail — `GMAIL_DEFAULT_ACCOUNT_ID`
2. Calendar API must be enabled in the Google Cloud project
3. Only the authenticated user's calendar is accessible by default
