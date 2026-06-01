---
name: linkedin-outreach
description: How to use the LinkedIn outreach connector (Linked API) for lead generation, connection requests, messaging, and GHL sync
---

# LinkedIn Outreach Skill

## Overview

Two connectors are available for LinkedIn outreach:

| Connector | Tool | Cost | Best For |
|-----------|------|------|----------|
| **`HeyReachConnector`** | HeyReach | $79/mo (up to 50 accounts) | Campaign orchestration, multi-account |
| **`LinkedInOutreachConnector`** | Linked API | $49/seat/mo | Per-action granular control |

**Default recommendation: HeyReach** for cost effectiveness at scale.

> [!CAUTION]
> **MANDATORY (retro 2026-04-23):** Before recommending a platform, ALWAYS check `.env` for which API key is actually configured (`HEYREACH_API_KEY` vs `LINKEDAPI_API_KEY`). The user may only have one platform active. Never assume HeyReach — verify first.

## Connector Locations

- `tesseract_operator/connectors/heyreach.py` — Campaign orchestration (primary)
- `tesseract_operator/connectors/linkedin_outreach.py` — Per-action control (alternative)

---

## HeyReach Connector

### Configuration

| Env Var | Required | Description |
|---------|----------|-------------|
| `HEYREACH_API_KEY` | Yes | API key from HeyReach dashboard → Integrations → API |
| `HEYREACH_BASE_URL` | No | Default: `https://api.heyreach.io` |

### API Methods

| Method | Purpose |
|--------|---------|
| `check_api_key()` | Verify credentials |
| `list_campaigns()` | List all outreach campaigns |
| `get_campaign()` | Get campaign details + sequence steps |
| `add_leads_to_campaign()` | **Core**: inject leads into a campaign |
| `add_linkedin_urls_to_campaign()` | Convenience: add by URL only |
| `get_lead()` | Get lead details by LinkedIn URL |
| `get_campaign_leads()` | List leads in a campaign (filter by status) |
| `get_conversations()` | Read LinkedIn inbox conversations |
| `send_message()` | Send message in existing conversation |
| `get_unread_replies()` | Get unread replies (hot leads) |
| `list_linkedin_accounts()` | List connected LinkedIn sender accounts |
| `get_campaign_stats()` | Campaign performance metrics |

### Outreach Workflow

```
1. Create campaign template in HeyReach UI (one-time)
2. Agent finds targets → add_leads_to_campaign()
3. HeyReach executes sequence automatically
4. Agent polls get_unread_replies() → sync to GHL
5. Agent sends hot lead alerts to Slack
```

---

## Linked API Connector (Alternative)

### Configuration

| Env Var | Required | Description |
|---------|----------|-------------|
| `LINKEDAPI_API_KEY` | Yes | API key from https://app.linkedapi.io |
| `LINKEDAPI_ACCOUNT_ID` | Yes | Connected LinkedIn account ID |
| `LINKEDAPI_BASE_URL` | No | Default: `https://api.linkedapi.io` |

### API Action Mappings

| Method | Linked API Action |
|--------|-------------------|
| `send_connection_request()` | `st.sendConnectionRequest` |
| `send_message()` | `st.sendMessage` |
| `check_connection_status()` | `st.checkConnectionStatus` |
| `list_connections()` | `st.retrieveConnections` |
| `search_people()` | `st.searchPeople` |
| `get_person_profile()` | `st.openPersonPage` |
| `sync_conversation()` | `st.syncConversation` |
| `visit_profile()` | `st.openPersonPage` |
| `react_to_post()` | `st.reactToPost` |
| `search_companies()` | `st.searchCompanies` |
| `get_company_employees()` | `st.retrieveCompanyEmployees` |
| `get_ssi()` | `st.retrieveSSI` |

### Daily Safety Limits (built-in)

| Action | Daily Limit |
|--------|:-----------:|
| Connection requests | 20 |
| Messages | 50 |

---

## GHL Integration Pattern

1. **New LinkedIn lead** → Create/update GHL contact with `source: linkedin`
2. **Connection accepted** → Move to pipeline stage "LinkedIn — Connected"
3. **Reply received** → Sync conversation to GHL notes
4. **Hot lead** → Slack notification

## Cross-Channel Dedup

When a LinkedIn profile URL exists in a GHL contact's custom fields,
skip Instantly email outreach to avoid double-touching.
