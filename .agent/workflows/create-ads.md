---
description: Create dynamic Facebook ads utilizing the Iterative Planner, the Ads Expert critique store, and explicit sandbox review.
---
<!-- planner:host-owned-workflow -->

# /create-ads

**Purpose**: To execute a standardized, human-in-the-loop recipe for deploying Dynamic Creative Optimization (DCO) campaigns using the marketing agents pipeline.

## Quick Start (3-Step Process)

```bash
# Step 1: Generate the draft — agents create copy, you review the HTML
python3 recipes/fb-ads-provisioning/scripts/generate_ad_draft.py --with-strategy --open

# Step 2: Approve the draft — promotes payload_draft.json → payload.json
python3 recipes/fb-ads-provisioning/scripts/generate_ad_draft.py --approve

# Step 3: Deploy to Meta — dry-run first, then --live
python3 recipes/fb-ads-provisioning/scripts/provision_dynamic_ads.py        # dry-run
python3 recipes/fb-ads-provisioning/scripts/provision_dynamic_ads.py --live # deploy
```

## Detailed Phase Mapping

### Phase 1: DRAFT — Agent-Driven Creative Generation

> [!CAUTION]
> **Validation Contract Gate (RETRO-034)**: Before modifying `marketing_playbooks.json` body copy, ALWAYS read `tesseract_operator/marketing/campaign_contract.py` first. It enforces emoji policy (allowed sets, emoji-to-text ratios), image count requirements, and hash uniqueness. Editing without reading the contract will cause `generate_ad_draft.py` to fail.

The `generate_ad_draft.py` script orchestrates the marketing team:

1. **MessagingContext** loads persona profiles, 7 evidence-backed statistics, and creative angle templates from the AI Fluency funnel documentation.
2. **CopywriterAgent** generates 3 creative angles (Pain Point, Credibility, Stat Bomb) with 5 headlines each, primary text, and descriptions.
3. **StrategistAgent** (optional, `--with-strategy`) ranks historical campaign performance and provides budget allocation recommendations.

**Output**:
- `ad_draft_review.html` — Premium dark-theme HTML report for visual review
- `payload_draft.json` — DCO payload in Meta-compatible format

**Flags**:
- `--angles "Pain Point" "Credibility"` — filter to specific creative angles
- `--with-strategy` — include campaign intelligence analysis
- `--open` — auto-open the HTML in the default browser

### Phase 2: REVIEW — Human Approval

1. Open `recipes/fb-ads-provisioning/ad_draft_review.html` in a browser.
2. Review all headlines, primary text, descriptions, and statistics.
3. If changes are needed:
   - Update the messaging context or funnel doc
   - Re-run `generate_ad_draft.py` to regenerate
4. If approved, run with `--approve` flag.

### Phase 3: APPROVE — Payload Promotion

Running `generate_ad_draft.py --approve`:
1. Backs up the current `payload.json` → `payload_previous.json`
2. Promotes `payload_draft.json` → `payload.json`
3. The provisioning script can now read the approved payload

### Phase 4: PROVISION — Meta API Deployment

> [!IMPORTANT]
> **Launch Semantics Gate (RETRO-034)**: If the user says "launch", "go live", "turn on", or "activate", they expect ACTIVE ads — not PAUSED. Either provision with `--status ACTIVE` or immediately activate after provisioning. If defaulting to PAUSED, explicitly tell the user and ask if they want activation. Always verify by querying the ad sets back from the API.

Run `provision_dynamic_ads.py`:
1. **Dry-run** (default) — validates payload structure and generates `creatives_expose.html`
2. **Live** (`--live`) — pushes the campaign, ad sets, and DCO creatives to the Meta Graph API

### Phase 5 (Optional): Generate Images

If the draft needs images, use the `generate_image` tool to create demographic-diverse visuals:
- 3-4 ethnicities, 2 genders, 2 age groups
- Individual AND group shots
- At least one image without people
- Add image paths to `payload.json` under the `images` array

## Files Reference

| File | Purpose |
|------|---------|
| `scripts/generate_ad_draft.py` | Agent-driven draft generation + HTML report |
| `scripts/provision_dynamic_ads.py` | Meta Graph API provisioning |
| `scripts/review_ads.py` | Review live campaign performance |
| `ad_draft_review.html` | Draft review report (agent output) |
| `creatives_expose.html` | Provisioning visual expose |
| `payload_draft.json` | Unapproved DCO payload |
| `payload.json` | Approved DCO payload (read by provisioner) |
| `payload_previous.json` | Previous payload backup |
