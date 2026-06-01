---
description: How to query Fireflies.ai meeting transcripts for lead enrichment and CRM context
---

# Fireflies.ai — Reference Skill

## Authentication
- API Key via `FIREFLIES_API_KEY` env var
- GraphQL API: `https://api.fireflies.ai/graphql`
- Connector: `tesseract_operator/connectors/fireflies.py`

## Integration Points
Fireflies data is consumed by other skills rather than having dedicated skills:
- `ghl.journey.map` — includes Fireflies recordings in contact journey
- `instantly.leads.enrich_and_sync` — cross-references with Fireflies transcripts
- Lead triage mission — checks for recent call recordings

## Usage Pattern
```python
ff = ctx.extras["fireflies"]
transcripts = ff.list_transcripts(limit=20, skip=0)
for t in transcripts:
    print(f"{t['title']} — {t['date']} — {t['duration']}min")
```

## Known Gotchas
1. GraphQL-only API — no REST endpoints
2. Transcripts include participant names that can be fuzzy-matched to CRM contacts
3. Always check Fireflies when enriching leads — meetings are high-signal data
