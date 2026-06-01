---
description: Review Facebook Ads campaigns — drill into ad sets, creatives, leads, and generate actionable insights
---

# Review Campaigns Workflow

A structured workflow for auditing Facebook Ads campaigns and producing a concise performance report for the user. All steps are **read-only** (LOW risk) — no campaigns are modified.

**When to use**: User asks to review campaigns, check ad performance, audit creatives, pull leads, or get recommendations.

---

## Phase 1: Campaign Overview

1. **List all active campaigns**:
// turbo
   ```
   cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
   python -c "
from tesseract_operator.connectors.facebook_ads import FacebookAdsConnector
from tesseract_operator.config import OperatorConfig
cfg = OperatorConfig.load()
fb = FacebookAdsConnector(app_id=cfg.facebook_app_id, app_secret=cfg.facebook_app_secret, access_token=cfg.facebook_access_token, ad_account_id=cfg.facebook_ad_account_id)
for c in fb.list_campaigns(limit=50):
    print(f\"[{c.get('status')}] {c.get('name')} (id={c.get('id')}, objective={c.get('objective')}, daily_budget={c.get('daily_budget')})\")"
   ```

2. **Record campaign IDs** for active campaigns you want to drill into.

---

## Phase 2: Performance Stats (per campaign)

For each campaign of interest, pull 30-day insights:

3. **Get campaign stats**:
// turbo
   ```
   cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
   python -c "
from tesseract_operator.connectors.facebook_ads import FacebookAdsConnector
from tesseract_operator.config import OperatorConfig
import json
cfg = OperatorConfig.load()
fb = FacebookAdsConnector(app_id=cfg.facebook_app_id, app_secret=cfg.facebook_app_secret, access_token=cfg.facebook_access_token, ad_account_id=cfg.facebook_ad_account_id)
stats = fb.get_campaign_stats('REPLACE_CAMPAIGN_ID')
print(json.dumps(stats, indent=2))"
   ```

4. **Key metrics to look at**:
   - **Spend** — total amount spent
   - **Impressions** — how many times ads were shown
   - **Clicks** — click count
   - **CPC** (Cost Per Click) — lower is better, benchmark: < $1.50
   - **CPM** (Cost Per 1000 Impressions) — benchmark: < $15
   - **CTR** — calculate as `clicks / impressions * 100`, good: > 1%
   - **Actions** — conversions, leads, or engagement events

---

## Phase 3: Ad Structure Deep-Dive

5. **List ad sets** per campaign:
// turbo
   ```
   cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
   python -c "
from tesseract_operator.connectors.facebook_ads import FacebookAdsConnector
from tesseract_operator.config import OperatorConfig
import json
cfg = OperatorConfig.load()
fb = FacebookAdsConnector(app_id=cfg.facebook_app_id, app_secret=cfg.facebook_app_secret, access_token=cfg.facebook_access_token, ad_account_id=cfg.facebook_ad_account_id)
for adset in fb.list_adsets('REPLACE_CAMPAIGN_ID'):
    print(f\"[{adset.get('status')}] {adset.get('name')} (id={adset.get('id')}, budget={adset.get('daily_budget')}, goal={adset.get('optimization_goal')})\")"
   ```

6. **List ads** per ad set:
// turbo
   ```
   cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
   python -c "
from tesseract_operator.connectors.facebook_ads import FacebookAdsConnector
from tesseract_operator.config import OperatorConfig
cfg = OperatorConfig.load()
fb = FacebookAdsConnector(app_id=cfg.facebook_app_id, app_secret=cfg.facebook_app_secret, access_token=cfg.facebook_access_token, ad_account_id=cfg.facebook_ad_account_id)
for ad in fb.list_ads('REPLACE_ADSET_ID'):
    print(f\"[{ad.get('status')}] {ad.get('name')} (id={ad.get('id')})\")"
   ```

---

## Phase 4: Creative Audit

7. **Review ad creatives** — check headlines, descriptions, images, and CTAs:
// turbo
   ```
   cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
   python -c "
from tesseract_operator.connectors.facebook_ads import FacebookAdsConnector
from tesseract_operator.config import OperatorConfig
import json
cfg = OperatorConfig.load()
fb = FacebookAdsConnector(app_id=cfg.facebook_app_id, app_secret=cfg.facebook_app_secret, access_token=cfg.facebook_access_token, ad_account_id=cfg.facebook_ad_account_id)
creative = fb.get_ad_creative('REPLACE_AD_ID')
print(json.dumps(creative, indent=2))"
   ```

8. **Creative quality checks**:
   - [ ] Headline is clear and compelling (< 40 characters ideal)
   - [ ] Body copy includes a value proposition
   - [ ] Image/video is high-quality and relevant
   - [ ] CTA matches the campaign objective (e.g. LEARN_MORE, SIGN_UP, CONTACT_US)
   - [ ] Landing page URL matches the ad promise

---

## Phase 5: Lead Pull (Lead-Gen Campaigns Only)

9. **Pull leads** from lead-gen ads:
// turbo
   ```
   cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
   python -c "
from tesseract_operator.connectors.facebook_ads import FacebookAdsConnector
from tesseract_operator.config import OperatorConfig
import json
cfg = OperatorConfig.load()
fb = FacebookAdsConnector(app_id=cfg.facebook_app_id, app_secret=cfg.facebook_app_secret, access_token=cfg.facebook_access_token, ad_account_id=cfg.facebook_ad_account_id)
leads = fb.get_ad_leads('REPLACE_AD_ID', limit=25)
for lead in leads:
    fields = {f['name']: f['values'][0] for f in lead.get('field_data', [])}
    print(f\"  [{lead.get('created_time')}] {fields}\")"
   ```

---

## Phase 6: Insights Report

10. **Compile a report** for the user with these sections:

    ```markdown
    ## 📊 Facebook Ads Review — [Date]

    ### Campaign Summary
    | Campaign | Status | Spend | Impressions | Clicks | CPC | CTR |
    |---|---|---|---|---|---|---|

    ### 🟢 What's Working
    - [Best-performing campaign/ad set and why]
    - [Strongest creative — headline + CTA combo]

    ### 🔴 What Needs Attention
    - [Underperforming campaigns: high CPC, low CTR]
    - [Creative fatigue signals: declining CTR over time]
    - [Budget wasted on low-performing ad sets]

    ### 💡 Recommendations
    1. [Pause underperforming ad sets — specify which]
    2. [Increase budget on top performer — specify amount]
    3. [Test new headline/creative — specify what to test]
    4. [Pull and follow up on new leads — specify count]
    ```

> [!IMPORTANT]
> This workflow is 100% read-only. The agent CANNOT publish, pause, or modify
> any campaigns. All HIGH-risk actions (`publish`, `update_budget`) are
> `mcp_exposed=False` and require manual intervention.
