# Eventbrite Integration: Attendees & Events

This skill provides a robust interface for syncing and searching Eventbrite attendees, hardened with auto-pagination and local-first data retrieval.

## 🔗 Connector: `EventbriteConnector`

**Python Path**: `tesseract_operator.connectors.eventbrite.EventbriteConnector`

### Key Methods
- `list_events(status="live", name_filter=None, auto_paginate=True)`: Fetches events with robust pagination.
- `list_attendees(event_id, status="attending", auto_paginate=True)`: Fetches all attendees for a given event ID.
- `get_event(event_id)`: Fetches basic event details.

---

## 🛠️ Skills

### 1. `eventbrite.attendees.sync`
**Purpose**: Fetches attendees from Eventbrite and upserts them into the local `ContactStore`.

**Usage**:
```python
# Sync a specific event
eventbrite_attendees_sync(ctx, event_id="123456789")

# Sync all active/draft events (Warning: SLOW if many events)
eventbrite_attendees_sync(ctx, event_id=None)
```

**Tags Created**:
- `eventbrite-attendee`: Global tag for all EB contacts.
- `eventbrite-event-{id}`: ID-based event tag.
- `eventbrite-{event-slug}`: Human-readable slug (first 30 chars).
- `eventbrite-ticket-{type}`: Ticket class name (slugified).

---

### 2. `eventbrite.attendees.search`
**Purpose**: Local-first search for Eventbrite attendees in `ContactStore`.

**Usage**:
```python
search_res = eventbrite_attendees_search(ctx, query="name@example.com")
# Returns a list of matches with EB tags.
```

---

## 💡 Best Practices (Gotchas)

- **G-039 | Targeted Sync Priority**: Never run a full sync (`event_id=None`) unless absolutely necessary. If you know the event name, filter events first and sync only the matching IDs.
- **Local-First**: Always check the local `ContactStore` via `eventbrite.attendees.search` before triggering a new sync to save API credits and time.
- **Pagination**: The connector handles pagination automatically by default. DO NOT try to implement manual pagination in skills. 
- **SkillContext**: Use `ctx.config`, not `ctx.cfg` (G-040).
