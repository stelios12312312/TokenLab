---
description: How to manage Facebook Ads campaigns, review creatives, pull leads, launch campaigns, send conversion events, and inspect ad performance via the Tesseract operator
---

# Facebook Ads Manager — Reference Skill

## Authentication
- Graph API v21.0 via `FACEBOOK_ACCESS_TOKEN` env var (long-lived, ~60 days)
- Ad Account ID via `FACEBOOK_AD_ACCOUNT_ID` env var
- Connector: `tesseract_operator/connectors/facebook_ads.py`
- Skills: `tesseract_operator/skills/facebook_ads_skills.py`

## Available Skills (18 total)

### Campaign Management

| Skill Name | Risk | MCP | Description |
|---|---|---|---|
| `facebook_ads.campaigns.list` | LOW | Yes | List all campaigns (follows pagination, up to 200) |
| `facebook_ads.campaigns.stats` | LOW | Yes | Get 30-day performance insights (impressions, clicks, spend, CPC, CPM) |
| `facebook_ads.campaigns.create_draft` | MEDIUM | Yes | Create a new campaign in PAUSED state (status is **hardcoded**, cannot be overridden) |
| `facebook_ads.campaigns.publish` | **HIGH** | No | Activate a paused campaign — requires approval |
| `facebook_ads.campaigns.update_budget` | **HIGH** | No | Change daily budget — $1,000/day ceiling enforced at connector layer |

### Ad Set Management

| Skill Name | Risk | MCP | Description |
|---|---|---|---|
| `facebook_ads.adsets.list` | LOW | Yes | List ad sets in a campaign (follows pagination) |
| `facebook_ads.adsets.create` | **HIGH** | No | Create a new ad set (always PAUSED) — requires approval |
| `facebook_ads.adsets.update_status` | **HIGH** | No | Pause, activate, or archive an ad set — requires approval |

### Ad & Creative Management

| Skill Name | Risk | MCP | Description |
|---|---|---|---|
| `facebook_ads.ads.list` | LOW | Yes | List individual ads in an ad set (follows pagination) |
| `facebook_ads.ads.creative` | LOW | Yes | Inspect ad creative: headline, body, image URL, CTA type |
| `facebook_ads.ads.leads` | LOW | Yes | Pull lead form submissions from lead-gen campaigns (follows pagination) |
| `facebook_ads.ads.preview` | LOW | Yes | Get ad preview HTML for visual inspection |
| `facebook_ads.ads.create_creative` | **HIGH** | No | Create an ad creative (image + copy + CTA) — requires approval |
| `facebook_ads.ads.create` | **HIGH** | No | Create an ad in an ad set using a creative — requires approval |

### Token Health

| Skill Name | Risk | MCP | Description |
|---|---|---|---|
| `facebook_ads.token.health` | LOW | Yes | Check token validity, expiry date, and remaining days. Warns if <7 days. |

### Audience Insights

| Skill Name | Risk | MCP | Description |
|---|---|---|---|
| `facebook_ads.audience.estimate` | LOW | Yes | Estimate audience size for a targeting spec |

### Meta Conversions API (CAPI)

| Skill Name | Risk | MCP | Description |
|---|---|---|---|
| `facebook_ads.capi.send_event` | **HIGH** | No | Send server-side conversion event to Meta (Lead, Purchase, etc.) — requires approval |

### FB Lead → GHL Sync

| Skill Name | Risk | MCP | Description |
|---|---|---|---|
| `facebook_ads.leads.sync_to_ghl` | MEDIUM | Yes | Pull FB leads and auto-create GHL contacts + pipeline opportunities |

## Campaign Launch Workflow

To launch a full campaign from Tesseract:

1. **Create campaign draft**: `facebook_ads.campaigns.create_draft` (MEDIUM — auto-allowed)
2. **Create ad creative**: `facebook_ads.ads.create_creative` (HIGH — needs approval)
3. **Create ad set**: `facebook_ads.adsets.create` (HIGH — needs approval)
4. **Create ad**: `facebook_ads.ads.create` (HIGH — needs approval)
5. **Review everything**: Use `list`/`creative`/`preview` skills to verify
6. **Publish campaign**: `facebook_ads.campaigns.publish` (HIGH — needs approval)

> All write operations create in PAUSED state. Nothing goes live until explicit `publish`.

## Meta Conversions API (CAPI) Usage

Fire conversion events back to Meta when real outcomes happen in GHL:

```python
# When a GHL opportunity moves to "Closed Won":
fb_capi_send_event(
    pixel_id="YOUR_PIXEL_ID",
    event_name="Purchase",
    user_email="customer@example.com",
    value=5000.0,
    currency="USD",
)
```

User data is automatically SHA-256 hashed before sending (Meta requirement).

## FB Lead → GHL Sync Usage

```python
# Sync leads from a FB lead-gen ad into GHL pipeline:
fb_leads_sync_to_ghl(
    ad_id="AD_ID",
    pipeline_id="PIPELINE_ID",
    stage_id="STAGE_ID",
    tag="fb-lead-sync",
)
```

For each lead: extracts email/name/phone → checks for existing GHL contact → creates contact + opportunity.

## Risk Tier Rules

- **LOW** (read-only): No side effects, agent can run freely
- **MEDIUM** (create draft, sync leads): Creates paused resources or GHL contacts — no spend
- **HIGH** (publish, budget, create ad/creative, CAPI): Activates spending or sends data externally — OpenClaw intercepts and requires manual approval

## Security Measures

1. **Authorization header**: Access token sent via `Authorization: Bearer` header, never in URL query params
2. **Budget ceiling**: $1,000/day hardcoded at the **connector layer** — no caller can bypass
3. **Status hardcoding**: `create_campaign_draft`, `create_adset`, and `create_ad` always set `status=PAUSED` regardless of caller input
4. **Pagination**: All list methods follow Graph API paging cursors (up to configurable max)
5. **Token monitoring**: `debug_token` endpoint checks validity and warns when <7 days from expiry
6. **CAPI hashing**: User PII is SHA-256 hashed before sending to Meta

## Known Gotchas

1. Budget values in the Graph API are in **cents** (e.g. $50.00 = 5000). The connector handles conversion automatically.
2. `ad_account_id` must start with `act_`. The connector auto-prefixes if needed.
3. The access token expires in ~60 days. Use `facebook_ads.token.health` to monitor. Re-generate via Graph API Explorer token exchange.
4. `get_ad_leads` only works on lead-gen campaign ads (objective: `OUTCOME_LEADS`).
5. Campaign `special_ad_categories` accepts a list `[]`. Specify `["HOUSING"]`, `["CREDIT"]`, or `["EMPLOYMENT"]` if applicable.
6. API version is `v21.0` (class constant `FacebookAdsConnector.API_VERSION`). Update when Meta releases new versions.
