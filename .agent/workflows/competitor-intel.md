<!-- planner:host-owned-workflow -->
# /competitor-intel

## Overview
This workflow triggers the `Competitor Analyst Agent` to scrape recent Facebook ads from key competitors using the Apify connector, process them via LLM, and update the `data/campaigns/competitor_swipe_file.json` cache with actionable messaging whitespace. The updated cache is then automatically loaded into the `MessagingContext` to inform the copywriter pipeline.

## Execution
To run the automated competitor intelligence sweep:

```bash
python3 recipes/competitor-intelligence/scripts/analyze_competitors.py
```

*Note: Requires `APIFY_API_TOKEN` in the environment to run the live scraper, otherwise falls back to a mock dry-run dataset.*
