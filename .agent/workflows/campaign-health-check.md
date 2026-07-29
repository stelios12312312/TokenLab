<!-- planner:host-owned-workflow -->
# /campaign-health-check Workflow

Run a health check across all AI Fluency marketing channels. Reports status of GHL, Email, Social, LinkedIn, Facebook Ads, Eventbrite, and Website Traffic.

## Quick Reference

| Action | Command |
|--------|---------|
| **One-off dry run** | `python3 scripts/campaign_health_check.py` |
| **One-off live (sends notifications)** | `python3 scripts/campaign_health_check.py --live` |
| **Start daemon (12-hourly auto)** | `tesseract-operator daemon` |
| **Check daemon logs** | `tail -f scheduler_daemon.log \| grep campaign_health` |

## Step 1: Verify Environment

Before running, ensure these are set in `.env`:

```bash
# Check required keys
grep -E "DAEMON_CRON_CAMPAIGN_HEALTH|TELEGRAM_BOT_TOKEN|SLACK_BOT_TOKEN|GMAIL_DEFAULT_ACCOUNT_ID|WEEKLY_REPORT_EMAIL_TO" .env
```

Required for notifications:
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_DEFAULT_CHAT_ID` → Telegram alerts
- `SLACK_BOT_TOKEN` + `SLACK_DEFAULT_CHANNEL` → Slack posts
- `GMAIL_DEFAULT_ACCOUNT_ID` + `WEEKLY_REPORT_EMAIL_TO` → Email digests

Required for daemon scheduling:
- `DAEMON_CRON_CAMPAIGN_HEALTH=0 */12 * * *` (default: every 12 hours)

## Step 2: Run the Check

### Option A: One-off (recommended first time)

```bash
# Dry run — shows results, no notifications
python3 scripts/campaign_health_check.py

# Live — sends Telegram + Slack + Email
python3 scripts/campaign_health_check.py --live
```

### Option B: Start the Daemon

The daemon runs ALL scheduled jobs (lead triage, daily brief, health check, etc.):

```bash
tesseract-operator daemon
```

Or run directly:
```bash
python3 -m tesseract_operator.cli daemon
```

The health check will fire automatically based on `DAEMON_CRON_CAMPAIGN_HEALTH`.

## Step 3: Interpret Results

| Status | Action Needed |
|--------|--------------|
| ✅ Healthy | None — channel working |
| ⚠️ Warning | Check manually — may be expected (e.g., new feature not yet used) |
| ❌ Down | **Immediate attention** — usually an expired token or API error |
| ⏸️ Inactive | Channel not configured — add API key to `.env` if needed |

## Common Issues

### Facebook Ads shows ❌ Down (401)
The Meta API token has expired. Refresh it:
1. Go to [Meta Business Suite → System Users](https://business.facebook.com/settings/system-users)
2. Generate a new token with `ads_read` permission
3. Update `META_ACCESS_TOKEN` in `.env`
4. Re-run the health check

### LinkedIn Warm Chase shows ⚠️ Warning
Expected until the first warm-chase cycle completes. The chase log will populate after the LinkedIn warm chase daemon job runs.

### Clarity shows ❌ or low sessions
Clarity API only supports a 3-day lookback window. Low session counts may be normal for low-traffic periods.

## Recipe Details

See `recipes/campaign-health-check/README.md` for full architecture and environment variable reference.
