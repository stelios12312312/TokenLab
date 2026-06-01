---
description: How to use the Eventbrite API v3 for events, attendees, orders, and ticket management
---

# Eventbrite API v3 — Reference Skill

## Authentication
- Bearer token via `EVENTBRITE_API_TOKEN` env var
- Organization ID via `EVENTBRITE_ORGANIZATION_ID` env var
- Base URL: `https://www.eventbriteapi.com/v3`
- Auth header: `Authorization: Bearer <token>`

## Available Skills

| Skill | Risk | MCP | Description |
|-------|------|-----|-------------|
| `eventbrite.events.list` | LOW | ✅ | List all events (filter by status) |
| `eventbrite.events.get` | LOW | ✅ | Get full details for a single event |
| `eventbrite.attendees.list` | LOW | ✅ | List attendees (name, email, status) |
| `eventbrite.orders.list` | LOW | ✅ | List orders/ticket purchases |
| `eventbrite.events.create` | HIGH | ❌ | Create a new draft event |
| `eventbrite.events.update` | MEDIUM | ✅ | Update event fields (title, dates, description) |
| `eventbrite.events.publish` | HIGH | ❌ | Publish a draft event (make it live) |
| `eventbrite.tickets.create` | MEDIUM | ✅ | Add a ticket class to an event |

> ⚠️ **HIGH-risk skills** (`events.create`, `events.publish`) are NOT MCP-exposed and require manual CLI invocation or approval tokens.

## CLI Commands

```bash
# READ operations (safe)
tesseract-operator eventbrite-events-list [--status live|draft|all] [--name-filter <substring>]
tesseract-operator eventbrite-event-get --event-id <ID>
tesseract-operator eventbrite-attendees-list --event-id <ID>
tesseract-operator eventbrite-orders-list --event-id <ID>

# WRITE operations (require approval/manual invocation)
tesseract-operator eventbrite-event-create --name "Title" --start "2026-04-01T10:00:00Z" --end "2026-04-01T11:00:00Z"
tesseract-operator eventbrite-event-update --event-id <ID> --name "New Title"
tesseract-operator eventbrite-event-publish --event-id <ID>
tesseract-operator eventbrite-ticket-create --event-id <ID> --name "General Admission" --quantity 100 --free
```

## Common Patterns

### List upcoming live events
```python
eb = EventbriteConnector(api_token=cfg.eventbrite_api_token, organization_id=cfg.eventbrite_organization_id, dry_run=False)
events = eb.list_events(status="live")
for ev in events["events"]:
    print(f"{ev['name']['text']} — {ev['start']['local']} — {ev['url']}")
```

### Search events by name (auto-paginates)
```python
eb = EventbriteConnector(api_token=cfg.eventbrite_api_token, organization_id=cfg.eventbrite_organization_id, dry_run=False)
results = eb.list_events(status="all", name_filter="creative")
for ev in results["events"]:
    print(f"{ev['name']['text']} — online={ev.get('online_event')} — venue_id={ev.get('venue_id')}")
```

### Get attendees with emails for a specific event
```python
data = eb.list_attendees(event_id="1219390041439")
for att in data["attendees"]:
    print(f"{att['profile']['name']} — {att['profile']['email']}")
```

### Create a draft event and add tickets
```python
# Step 1: Create draft
event = eb.create_event(
    name="AI for Executives Workshop",
    start_utc="2026-05-01T09:00:00Z",
    end_utc="2026-05-01T12:00:00Z",
    timezone="Europe/London",
    summary="Learn how AI transforms executive decision-making",
)
event_id = event["id"]

# Step 2: Add ticket class
eb.create_ticket_class(event_id=event_id, name="Free Entry", quantity_total=100, free=True)

# Step 3: Publish (when ready)
eb.publish_event(event_id=event_id)
```

## Organization Details
- **Organization**: Tesseract Academy
- **Organization ID**: `509461882073`
- **Organizer ID**: `32349114715`

## Known Event IDs (Live)
These are current live events as of March 2026:
- AI for accountants series
- AI to non-technical decision makers series
- What startups need to know about AI series

Use `eventbrite-events-list` to get current IDs — they rotate as series instances expire.

## Integration with KB Skills
The `kb.academy.events` skill in `kb_skills.py` automatically queries live Eventbrite data and falls back to the static `ACADEMY_EVENTS` list if the API is unavailable.

## Known Gotchas
1. **Events are in series** — each instance has a unique ID but shares a `series_id`
2. **Pagination** — Eventbrite uses `has_more_items` flag and `continuation` token
3. **Create always drafts** — the `create_event` method sets `listed=False` by default; use `publish_event` separately
4. **Token scope** — the Private Token must have read+write scope for CRUD operations
5. **Rate limits** — Eventbrite rate-limits to ~1000 requests/hour; the connector uses `ApiCacheStore` with 1-hour TTL
