---
description: How to query the Instantly API v2 efficiently for leads, replies, and campaign analytics
---

# Instantly API v2 — Reference Skill

## Authentication
- Bearer token via `INSTANTLY_API_KEY` env var
- Base URL: `https://api.instantly.ai`
- Auth header: `Authorization: Bearer <key>`

## Quick Reference: Endpoints That Work

### V2 Capabilities: Campaign & Lead Creation
As of API V2 (with V1 deprecated in Jan 2026), you have **full programmatic control** to create campaigns from scratch AND populate them with leads:
- **Campaigns**: Create new campaigns, set schedules, build/manage sequences (including A/Z testing), and update them via `/api/v2/campaign-subsequence` endpoints.
- **Leads**: Add single or bulk (up to 500) leads directly to a `campaign_id`, update custom variables, move leads between campaigns, and automatically skip existing leads via `/api/v2/leads` endpoints.

| Action | Method | Endpoint | Key Params |
|---|---|---|---|
| List campaigns | GET | `/api/v2/campaigns` | `limit`, `skip` |
| Campaign analytics | GET | `/api/v2/campaigns/analytics/overview` | `campaign_id` (optional) |
| List emails (Unibox) | GET | `/api/v2/emails` | `limit`, `skip` |
| Get single email | GET | `/api/v2/emails/{id}` | — |
| List leads | POST | `/api/v2/leads/list` | `campaign_id`, `limit`, `status`, `search`, `starting_after` |
| Update lead interest status | POST | `/api/v2/leads/update-interest-status` | `email`, `campaign_id`, `lt_interest_status` |
| **List opportunities** | GET | `/api/v2/opportunities` | `limit`, `skip` |
| **Search opportunities** | GET | `/api/v2/opportunities/search` | `q`, `limit` |
| **Get opportunity** | GET | `/api/v2/opportunities/{id}` | — |
| **Update opportunity** | PATCH | `/api/v2/opportunities/{id}` | `status` |
| **Create opportunity** | POST | `/api/v2/opportunities` | `lead_id` (required) |

> ⚠️ **CRITICAL**: Leads ≠ Opportunities. Campaign leads live at `/api/v2/leads/list`.
> CRM pipeline deals live at `/api/v2/opportunities`. When a user says "move lead X
> to Meeting Completed", check **opportunities first**, then fall back to leads.
> Opportunities require the `opportunities` API scope on the key.


## Lead Status Values (Campaign Position)

| status | Meaning |
|---|---|
| 0 | Not contacted / queued |
| 1 | Replied / Engaged |
| 2 | Bounced |
| 3 | Sequence Completed (Finished without reply, usually) |
| -1 | Unsubscribed |

> ⚠️ **CRITICAL: API KEY LIMITATION**: 
> The Tesseract `INSTANTLY_API_KEY` currently throws `HTTP 401 ERR_AUTH_FAILED` when hitting `/opportunities` endpoints. You **cannot** use the API to fetch CRM-tagged "Interested" or "Meeting Booked" leads directly. 
> To find engaged leads, pull `status=1` from `/leads/list` and use the local OpenAI/Gmail context parsing (`ghl_skills.py`) to infer their true intent.

## Lead Interest Status Values (CRM stage)

| lt_interest_status | Meaning |
|---|---|
| 0 | Out of Office |
| 1 | Interested |
| 2 | Meeting Booked |
| 3 | Meeting Completed |
| 4 | Won |
| -1 | Not Interested |
| -2 | Wrong Person |
| -3 | Lost |
| -4 | No Show |

## Correct Way to Find Interested/Replied Leads

```python
# ✅ DO: Use the leads endpoint with status filter
resp = client.request('POST', '/api/v2/leads/list', json_body={
    'campaign_id': campaign_id,
    'status': 3,  # interested
    'limit': 100,
})
leads = resp.json().get('items', [])
```

```python
# ❌ DON'T: Scan thousands of emails trying to reconstruct threads
# This hits rate limits and returns unreliable data
for skip in range(0, 5000, 50):
    resp = client.request('GET', '/api/v2/emails', params={'limit': 50, 'skip': skip})
```

## Fuzzy Lead Search & Campaign Discovery Pattern

When you don't know the exact spelling of a lead name, or need to discover which `campaign_id` a lead belongs to globally, use the fuzzy search:
```python
# Iterates through active campaigns and returns scored matches.
# Each match is injected with its source `campaign_id`.
# Uses difflib.SequenceMatcher to compare query against
# first_name, last_name, company_name, email prefix, and domain.
matches = connector.fuzzy_search_leads(query="Kolleris", threshold=0.6)
for m in matches:
    print(f"[{m['campaign_id']}] {m['first_name']} {m['last_name']} ({m['email']}) — "
          f"score: {m['match_score']}, field: {m['match_field']}")
```

## Updating Lead CRM Status

```python
# Move a lead to "Meeting Completed" (status 3)
connector.update_lead_interest_status(
    lead_email="lead@example.com",
    campaign_id="bf3eab6b-...",
    new_status=3,
)
```

## Pagination Pattern

The leads endpoint uses cursor pagination:
```python
cursor = None
all_leads = []
while True:
    body = {'campaign_id': cid, 'limit': 100, 'status': 3}
    if cursor:
        body['starting_after'] = cursor
    resp = client.request('POST', '/api/v2/leads/list', json_body=body)
    data = resp.json()
    items = data.get('items', [])
    all_leads.extend(items)
    cursor = data.get('next_starting_after')
    if not cursor or len(items) < 100:
        break
    time.sleep(0.3)
```

## Rate Limits
- Add `time.sleep(0.3)` minimum between calls
- Handle HTTP 429 with exponential backoff
- Email endpoint throttles around ~950 sequential calls

## Known Gotchas
See `.agent/gotchas.md` for the full list. Key ones:
1. `ue_type` doesn't reliably separate inbound vs outbound
2. `from_address_email` search returns sending-account emails, not prospect emails
3. Use leads endpoint (`POST /api/v2/leads/list`), never brute-force email scanning
4. Campaign list is `GET /api/v2/campaigns` (not `/list`)
5. `campaign_id` filter on `/api/v2/leads/list` may be ignored — returns all leads regardless
6. Fuzzy search paginates all leads; for large databases this can take 30+ seconds
7. Email body text is NOT available via `GET /api/v2/emails` list endpoint — use cPanel forwarding to Gmail instead (see `.agent/skills/cpanel/SKILL.md` and G-028)
8. Use `PATCH /api/v2/leads/{id}` to update `lt_interest_status` (POST endpoint returns 400)

## Detecting Unanswered Leads

```python
# Best approach: pull leads with replies, compare timestamps
leads = connector.list_leads(campaign_id=cid, status=3, limit=500)  # interested
unanswered = [
    l for l in leads
    if l.get('email_reply_count', 0) > 0
    and (l.get('timestamp_last_reply') or '') > (l.get('timestamp_last_contact') or '')
]
# Sort by most recent reply
unanswered.sort(key=lambda l: l.get('timestamp_last_reply', ''), reverse=True)
```

> ⚠️ **NOTE**: Check ALL statuses, not just status=3. Use no status filter for comprehensive scan.

## Updating Lead Status (PATCH)

```python
# Step 1: Find the lead
resp = client.request('POST', '/api/v2/leads/list', json_body={
    'campaign_id': cid, 'search': 'email@domain.com', 'limit': 1,
})
lead_id = resp.json()['items'][0]['id']

# Step 2: PATCH (not POST update-interest-status)
resp = client.request('PATCH', f'/api/v2/leads/{lead_id}', json_body={
    'lt_interest_status': 1,  # See INTEREST_STATUS_LABELS
})
```

## Gmail Reply Rules (G-010)

When replying to an Instantly lead via Gmail, **always CC**:
1. `vasileios@thetesseractacademy.com`
2. The original sending email from `status_summary.lastStep.from`
3. Any CCs from the prospect's original reply

