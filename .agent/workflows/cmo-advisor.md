---
description: Run the Synthetic CMO advisory — analyze telemetry data against brand guidelines and produce actionable marketing recommendations
---
<!-- planner:host-owned-workflow -->

# /cmo-advisor Workflow

Run a full Synthetic CMO advisory session. Produces structured findings with health scores, brand alignment analysis, and executable recommendations.

## Prerequisites

Telemetry data must be fresh (≤48h old). If caches are stale, harvest first.

## Steps

1. **Check cache freshness** — verify telemetry data is current:
   ```
   Use skill: telemetry.get_staleness
   ```
   If any cache is stale, run `telemetry.harvest_all` first.

2. **Join context** — merge all harvester caches into unified view:
   ```
   Use skill: telemetry.join_context
   ```
   This produces `url_context.json` and `contact_context.json`.

3. **List critical pages** — find pages needing immediate attention:
   ```
   Use skill: cmo.list_critical_pages (threshold=50)
   ```
   Focus on pages scoring below 50 first.

4. **Run advisory per page** — for each critical page, get the full advisory:
   ```
   Use skill: cmo.run_advisory (url=<page_url>)
   ```
   This returns the health score breakdown, advisory prompt, and context.

5. **Get sub-persona analysis** — optionally drill into specific concerns:
   - For content issues: `cmo.get_persona_prompt (persona=content_strategist)`
   - For ad performance: `cmo.get_persona_prompt (persona=ad_optimizer)`
   - For CRM alignment: `cmo.get_persona_prompt (persona=pipeline_analyst)`

6. **Validate findings** — ensure all recommendations follow the Decision Taxonomy:
   ```
   Use skill: cmo.validate_findings (findings=[...])
   ```
   Categories: MESSAGING_MISMATCH, UX_FRICTION, DEVICE_PARITY_ISSUE, STALE_CONTENT, SPEND_INEFFICIENCY, CONVERSION_FLOW_BROKEN.

7. **Present summary** — format results as a prioritized action plan:
   - P0 (Critical): Pages with health score <25 and paid traffic
   - P1 (High): Pages with health score 25-50
   - P2 (Medium): Pages with health score 50-70
   - P3 (Low): Pages with health score >70 but with improvement opportunities

## Health Score Components

| Component | Weight | What It Measures |
|-----------|--------|-----------------|
| Message Alignment | 25% | Ad promise vs. landing page content match |
| UX Quality | 25% | Rage clicks, scroll depth, friction signals |
| Mobile Parity | 20% | Mobile vs. desktop experience gap |
| Content Freshness | 15% | Stale date references, outdated copy |
| Conversion Flow | 15% | CTA presence, event/payment endpoint linkage |
