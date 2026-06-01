# /launch-campaign — Multi-Channel Campaign Orchestration

## When to use

Launch a coordinated marketing campaign across Facebook Ads, Email, and LinkedIn from a single playbook.

## Prerequisites

- Marketing playbook configured in `recipes/marketing_playbooks.json`
- API keys set for target channels (META_ACCESS_TOKEN, INSTANTLY_API_KEY, HEYREACH_API_KEY)
- Eventbrite API key for participant tracking (EVENTBRITE_API_KEY)

## Phases

### 1. PREFLIGHT
```
- Load playbook by ID
- Validate schema (reject unknown fields — M-001 guard)
- Check all connector credentials
- Report: which channels are live, which are stubbed
```

### 2. LAUNCH (dry-run first)
```
- Always start with --mode dry_run
- Generate launch manifest showing what WOULD be created
- Review manifest with user
- If approved, re-run with --mode live
```

### 3. MONITOR
```
- Check FB Ads campaign status via /review-campaigns
- Check Instantly sequence stats
- Check HeyReach pipeline
- Flag anomalies (spend spikes, bounce rates, low acceptance)
```

### 4. REPORT
```
python scripts/cmo_campaign_report.py --playbook-id <ID> --days 30 --open
```

### 5. LEARN
```
- Run participant intelligence analysis
- Feed recommendations back into playbook
- Document targeting refinements for next iteration
```

## Quick Start

```bash
# Dry-run launch
python -c "
from tesseract_operator.agents.base import AgentContext
from tesseract_operator.agents.marketing_team import CampaignDirectorAgent
agent = CampaignDirectorAgent()
ctx = AgentContext(run_id='launch-test', config_env='development')
result = agent.launch_campaign(ctx, playbook_id='ai_fluency_q3_leadership', mode='dry_run')
import json; print(json.dumps(result, indent=2))
"

# Generate report
python scripts/cmo_campaign_report.py --playbook-id ai_fluency_q3_leadership --dry-run --open
```

## Safety

- **Dry-run by default** — live mode requires explicit `--mode live`
- **Stub warnings** — G-029 guard ensures reports warn when connectors are stubbed
- **Idempotent** — launch manifest tracks per-channel state for safe retries
