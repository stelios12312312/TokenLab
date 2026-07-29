<!-- planner:host-owned-workflow -->
# /linkedin-outreach — LinkedIn Outreach Automation

Run LinkedIn outreach sequences using HeyReach (primary) or Linked API (alternative).

## Recommended Stack: HeyReach ($79/mo for up to 50 LinkedIn accounts)

### Prerequisites
- `HEYREACH_API_KEY` set in `.env`
- LinkedIn account(s) connected at https://app.heyreach.io
- At least one campaign created in the HeyReach dashboard

## How It Works

```
1. Design campaign sequences in HeyReach UI (one-time)
   → e.g., "AI Fluency Executive Outreach":
     Step 1: Send connection request + note
     Step 2: Wait 2 days
     Step 3: Send intro message
     Step 4: Wait 3 days  
     Step 5: Send follow-up

2. Agent finds targets (via LinkedIn search, CSV, GHL, Instantly)
   → Adds them to the campaign via API

3. HeyReach auto-executes the sequence across all LinkedIn accounts
   → Handles timing, randomization, safety limits

4. Agent monitors replies via inbox API
   → Syncs conversations to GHL notes
   → Sends Slack notifications for hot leads
```

## Usage Examples

### Add leads to a campaign
```python
from tesseract_operator.connectors.heyreach import HeyReachConnector

connector = HeyReachConnector(
    api_key=config.heyreach_api_key,
    base_url=config.heyreach_base_url,
    dry_run=config.dry_run,
)

# Simple: add by LinkedIn URLs
connector.add_linkedin_urls_to_campaign(
    campaign_id="your_campaign_id",
    linkedin_urls=[
        "https://linkedin.com/in/target-1",
        "https://linkedin.com/in/target-2",
    ],
)

# Rich: add with metadata
connector.add_leads_to_campaign(
    campaign_id="your_campaign_id",
    leads=[
        {
            "linkedinUrl": "https://linkedin.com/in/ceo-person",
            "firstName": "Jane",
            "lastName": "Doe",
            "companyName": "Acme Corp",
            "title": "CEO",
            "customUserFields": {"source": "instantly_crossref"},
        },
    ],
)
```

### Monitor replies and sync to GHL
```python
# Get unread replies
unread = connector.get_unread_replies(campaign_id="your_campaign_id")

for conv in unread:
    # Sync to GHL
    ghl.add_note(
        contact_id=find_ghl_contact(conv["leadLinkedinUrl"]),
        body=f"LinkedIn reply from {conv['leadName']}:\n{conv['lastMessage']}",
    )
    
    # Slack notification for hot leads
    slack.send_message(
        channel="#leads",
        text=f"🔥 LinkedIn reply from {conv['leadName']}: {conv['lastMessage'][:100]}",
    )
```

### Check campaign performance
```python
campaigns = connector.list_campaigns()
for camp in campaigns:
    stats = connector.get_campaign_stats(campaign_id=camp["id"])
    print(f"{camp['name']}: {stats['connection_rate']:.0%} connect, {stats['reply_rate']:.0%} reply")
```

## Multi-Channel Orchestration
1. Find prospect in Instantly (email bounce or no reply)
2. Cross-reference LinkedIn URL 
3. Add to HeyReach campaign via API
4. If LinkedIn reply → sync to GHL, mark in Instantly as "engaged"
5. If no LinkedIn reply either → mark as cold in GHL

## Alternative: Linked API ($49/seat/mo)
If you need per-action control (visit profile, react to post, etc.)
rather than campaign-based automation, use the `LinkedInOutreachConnector`
in `linkedin_outreach.py`. More expensive at scale but gives granular control.
