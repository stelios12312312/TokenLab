---
description: Review existing Facebook Ads (draft or published) and generate an HTML report for analysis
---

# /review-ads

**Purpose**: Generate a comprehensive, read-only HTML report of all existing Facebook Ads campaigns (active, paused, or archived), including their creatives, performance stats, and any local draft payload queued for deployment.

**When to use**: When the user wants to review current ads, audit creatives, compare live campaigns against local drafts, or prepare feedback for the next `/create-ads` cycle.

## Invocation

When the user types `/review-ads` or asks to review existing ads, follow these steps:

## Steps

### 1. Run the review script
```bash
cd "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine"
python3 recipes/fb-ads-provisioning/scripts/review_ads.py
```

Optional flags:
- `--status ACTIVE` — only show active campaigns
- `--status PAUSED` — only show draft/paused campaigns

### 2. Present the report
The script generates `recipes/fb-ads-provisioning/ads_review.html`. Instruct the user to open it in their browser.

### 3. Collect feedback
If the user provides feedback on any creatives, headlines, images, or targeting:
1. Store the critique via `cmo_advisor.store_ad_critique(...)` for future reference.
2. If the user wants to make changes, transition into the `/create-ads` workflow to generate a revised `payload.json`.

> [!IMPORTANT]
> This workflow is 100% **read-only**. The agent CANNOT publish, pause, or modify any campaigns.
> All analysis is performed locally against data already fetched from the Meta Graph API.
